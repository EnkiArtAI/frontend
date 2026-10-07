import { isDbUnreachable, dbUnavailableResponse } from "@/lib/db-error";
/**
 * GET /api/marketplace/prompts
 * Advanced marketplace search and filtering with full-text search
 */

import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { PROMPT_CARD_SELECT, mapPromptRow, enrichPromptCards, type PromptListing } from "@/lib/marketplace/card";
import { hideAdult, viewer } from "@/lib/adult-content";
import { z } from "zod";

const marketplaceFiltersSchema = z.object({
  // Full-text search
  query: z.string().optional(),                    // Search terms

  // Categorical filters
  category: z.string().optional(),                // Single category
  categories: z.array(z.string()).optional(),     // Multiple categories
  licenseType: z.array(z.string()).optional(),    // Multiple license types
  tags: z.array(z.string()).optional(),           // Tag filtering

  // Price filters
  priceFilter: z.enum(['all', 'free', 'paid']).optional(), // Filter by price type
  minPrice: z.number().int().min(0).optional(),   // Minimum price in cents
  maxPrice: z.number().int().min(0).optional(),   // Maximum price in cents

  // Quality filters
  minRating: z.number().min(0).max(5).optional(), // Minimum rating
  minSales: z.number().int().min(0).optional(),   // Minimum sales count

  // Sorting options
  sortBy: z.enum([
    'relevance', 'newest', 'price_low', 'price_high',
    'popular', 'rating', 'trending'
  ]).default('relevance'),

  sortOrder: z.enum(['asc', 'desc']).optional(),

  // Pagination
  limit: z.number().int().min(1).max(50).default(12),
  cursor: z.string().optional(),
});

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);

    // Parse query parameters into filter object
    const filters = {
      query: searchParams.get('query') || undefined,
      category: searchParams.get('category') || undefined,
      categories: searchParams.getAll('categories').length > 0 ? searchParams.getAll('categories') : undefined,
      licenseType: searchParams.getAll('licenseType').length > 0 ? searchParams.getAll('licenseType') : undefined,
      tags: searchParams.getAll('tags').length > 0 ? searchParams.getAll('tags') : undefined,
      priceFilter: (searchParams.get('priceFilter') as 'all' | 'free' | 'paid' | null) || undefined,
      minPrice: searchParams.get('minPrice') ? parseInt(searchParams.get('minPrice')!) : undefined,
      maxPrice: searchParams.get('maxPrice') ? parseInt(searchParams.get('maxPrice')!) : undefined,
      minRating: searchParams.get('minRating') ? parseFloat(searchParams.get('minRating')!) : undefined,
      minSales: searchParams.get('minSales') ? parseInt(searchParams.get('minSales')!) : undefined,
      sortBy: (searchParams.get('sortBy') as any) || 'relevance',
      sortOrder: (searchParams.get('sortOrder') as any) || undefined,
      limit: parseInt(searchParams.get('limit') || '12'),
      cursor: searchParams.get('cursor') || undefined,
    };

    const validation = marketplaceFiltersSchema.safeParse(filters);
    if (!validation.success) {
      return NextResponse.json(
        {
          success: false,
          error: "Invalid query parameters",
          details: validation.error.issues
        },
        { status: 400 }
      );
    }

    const {
      query, category, categories, licenseType, tags,
      priceFilter, minPrice, maxPrice, minRating, minSales,
      sortBy, sortOrder, limit, cursor
    } = validation.data;
    const offset = cursor ? parseInt(cursor, 10) || 0 : 0;

    // Build MongoDB query
    const mongoQuery: any = {
      isListed: true,
      listingStatus: 'active'
    };

    // Add text search if query provided
    if (query && query.trim()) {
      mongoQuery.$text = { $search: query.trim() };
    }

    // Add category filter
    if (category) {
      mongoQuery.category = category;
    } else if (categories && categories.length > 0) {
      mongoQuery.category = { $in: categories };
    }

    // Add license type filter
    if (licenseType && licenseType.length > 0) {
      mongoQuery.licenseType = { $in: licenseType };
    }

    // Add tags filter
    if (tags && tags.length > 0) {
      mongoQuery.tags = { $in: tags };
    }

    // Add price range filter
    // Support free prompt filtering via priceFilter query param
    if (priceFilter === 'free') {
      // Filter for free prompts only (priceUsdCents === 0)
      mongoQuery.priceUsdCents = 0;
    } else if (priceFilter === 'paid') {
      // Filter for paid prompts only (priceUsdCents > 0)
      mongoQuery.priceUsdCents = { $gt: 0 };
    } else if (minPrice !== undefined || maxPrice !== undefined) {
      // Use explicit price range if provided
      mongoQuery.priceUsdCents = {};
      if (minPrice !== undefined) mongoQuery.priceUsdCents.$gte = minPrice;
      if (maxPrice !== undefined) mongoQuery.priceUsdCents.$lte = maxPrice;
    }

    // Add rating filter
    if (minRating !== undefined) {
      mongoQuery.avgRating = { $gte: minRating };
    }

    // Add sales filter
    if (minSales !== undefined) {
      mongoQuery.totalSales = { $gte: minSales };
    }

    // Build sort specification
    let sortSpec: any = {};
    const sortDirection = sortOrder === 'asc' ? 1 : -1;

    switch (sortBy) {
      case 'relevance':
        // For text search, relevance is handled by MongoDB's text score
        if (query) {
          sortSpec = { score: { $meta: "textScore" } };
        } else {
          sortSpec = { listedAt: -1 }; // Fallback to newest
        }
        break;
      case 'newest':
        sortSpec = { listedAt: -1 };
        break;
      case 'price_low':
        sortSpec = { priceUsdCents: 1 };
        break;
      case 'price_high':
        sortSpec = { priceUsdCents: -1 };
        break;
      case 'popular':
        sortSpec = { totalSales: -1, listedAt: -1 };
        break;
      case 'rating':
        sortSpec = { avgRating: -1, ratingCount: -1 };
        break;
      case 'trending':
        // Combine recency and popularity
        sortSpec = { listedAt: -1, totalSales: -1 };
        break;
      default:
        sortSpec = { listedAt: -1 };
    }

    // Execute search query
    let prompts: PromptListing[] = [];
    try {
      const supabase = getSupabaseServerClient();

      /*
       * Live-schema boundary (probed 2026-08-12): the columns this query used
       * to filter, sort and read — price, downloads, rating, user_id,
       * uploaded_photos — do not exist (PostgREST 400 kills the whole select).
       * Live: price_usd_cents (integer cents — the same unit minPrice/maxPrice
       * are documented in), creator_id, showcase_images (jsonb URL strings).
       * The column list and the card shape live in lib/marketplace/card.ts,
       * shared with /api/search.
       */
      let dbQuery = supabase.from("prompts").select(PROMPT_CARD_SELECT);

      // Released prompts only. Without this a draft was on the marketplace the
      // moment it was saved — see app/api/prompts/route.ts for the same fix.
      dbQuery = dbQuery.eq("is_listed", true);

      /* ?models=<alias>&models=… narrows to prompts made with the picked
         generators (Kev, 2026-08-24: filter the wall by launcher). The
         client sends every alias per generator (id, name, family slug)
         because prompts.ai_model historically stores names AND slugs mixed
         — "Flux (free)" next to "nano-banana-pro". */
      const modelAliases = searchParams.getAll("models").filter(Boolean);
      if (modelAliases.length > 0) {
        dbQuery = dbQuery.in("ai_model", modelAliases);
      }

      /* ?creator=<handle|uuid> narrows to one artist's shelf — the foreign
         profile page (Kev, 2026-08-24: creators render like the own profile)
         reads its Released tab through the SAME query and mapping as the
         feed, so the two can never drift. Unknown handle → empty list. */
      const creator = searchParams.get("creator");
      let creatorId: string | null = null;
      if (creator) {
        const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        creatorId = creator;
        if (!UUID.test(creator)) {
          const { data: u } = await supabase
            .from("users").select("id").eq("handle", creator).maybeSingle();
          creatorId = u?.id ?? "00000000-0000-0000-0000-000000000000";
        }
        dbQuery = dbQuery.eq("creator_id", creatorId);
      }
      // 18+ only for a confirmed adult with the pill on; an artist's own shelf
      // always shows it.
      dbQuery = hideAdult(dbQuery, await viewer(supabase, request), creatorId);

      if (category) {
        dbQuery = dbQuery.eq("category", category);
      }

      if (tags && tags.length > 0) {
        dbQuery = dbQuery.overlaps("tags", tags);
      }

      if (priceFilter === "free") {
        dbQuery = dbQuery.eq("price_usd_cents", 0);
      } else if (priceFilter === "paid") {
        dbQuery = dbQuery.gt("price_usd_cents", 0);
      } else if (minPrice !== undefined || maxPrice !== undefined) {
        if (minPrice !== undefined) dbQuery = dbQuery.gte("price_usd_cents", minPrice);
        if (maxPrice !== undefined) dbQuery = dbQuery.lte("price_usd_cents", maxPrice);
      }

      if (query && query.trim()) {
        dbQuery = dbQuery.ilike("title", `%${query.trim()}%`);
      }

      // Sort
      switch (sortBy) {
        case "newest":
          dbQuery = dbQuery.order("created_at", { ascending: false });
          break;
        case "popular":
          // No sales/downloads column exists live; recency is the only
          // honest order until engagement lands on the prompts row.
          dbQuery = dbQuery.order("created_at", { ascending: false });
          break;
        case "price_low":
          dbQuery = dbQuery.order("price_usd_cents", { ascending: true });
          break;
        case "price_high":
          dbQuery = dbQuery.order("price_usd_cents", { ascending: false });
          break;
        case "trending":
        default:
          dbQuery = dbQuery.order("created_at", { ascending: false });
          break;
      }

      dbQuery = dbQuery.range(offset, offset + limit - 1);

      const { data: dbPrompts, error: dbError, count } = await dbQuery;

      if (dbError) {
        console.error("Supabase query error:", dbError);
        throw dbError;
      }

      if (Array.isArray(dbPrompts) && dbPrompts.length > 0) {
        prompts = dbPrompts.map(mapPromptRow);
      }

    } catch (searchError) {
      // A dead host is an answer, not an empty feed.
      if (isDbUnreachable(searchError)) return dbUnavailableResponse();
      console.error('Search query failed:', searchError);
    }

    // Enrich with creator data and variables (lib/marketplace/card.ts).
    const enrichedPrompts = await enrichPromptCards(getSupabaseServerClient(), prompts);

    // Calculate pagination
    const hasMore = enrichedPrompts.length === limit;
    const nextCursor = hasMore ? String(offset + limit) : undefined;

    // Build response
    return NextResponse.json({
      prompts: enrichedPrompts,
      total: enrichedPrompts.length,
      hasMore,
      nextCursor,
      filters: {
        applied: {
          query,
          category,
          categories,
          licenseType,
          tags,
          priceFilter,
          minPrice,
          maxPrice,
          minRating,
          minSales,
          sortBy,
          sortOrder,
        }
      },
      searchInfo: {
        query,
        totalResults: enrichedPrompts.length,
        hasSearchQuery: !!query,
        sortApplied: sortBy,
      }
    });

  } catch (error) {
    if (isDbUnreachable(error)) return dbUnavailableResponse();
    console.error('Error fetching marketplace prompts:', error);
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    );
  }
}

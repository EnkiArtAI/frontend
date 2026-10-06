// app/api/generations/route.ts
import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { hideAdult, viewer } from "@/lib/adult-content";
import { notifyEvent } from "@/lib/notifications";
import { substituteVariables } from "@/backend/services/variable-substitution";
import { encryptPrompt } from "@/backend/encryption";
import {
  createGenerationSchema,
  getGenerationsQuerySchema,
  validateBody,
  validateQuery,
  createErrorResponse,
  createSuccessResponse
} from "../../middleware/validation";

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);

    // Validate query parameters
    const queryValidation = validateQuery(getGenerationsQuerySchema, searchParams);
    if (!queryValidation.success) {
      const errorMessages = queryValidation.errors.map((err: any) => `${err.path.join('.')}: ${err.message}`);
      return createErrorResponse('Invalid query parameters', 400, errorMessages);
    }

    const { limit = 50, offset = 0 } = queryValidation.data;
    // Support both userKey (legacy) and userId
    const userId = searchParams.get("userId") || searchParams.get("userKey");

    if (!userId) {
      return createErrorResponse('userId or userKey is required', 400);
    }

    const supabase = getSupabaseServerClient();

    // Galleries pass a WALLET ADDRESS, the tables key on a user uuid. This used
    // to give up and return an empty list for every wallet caller — which is
    // why the gallery looked empty even when images existed. Resolve it.
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId);
    let ownerId = isUuid ? userId : null;
    if (!ownerId) {
      const { data: walletRow } = await supabase
        .from("user_wallets")
        .select("user_id")
        // addresses are stored lowercased; base58 is case-sensitive, so compare
        // case-insensitively rather than missing every Solana wallet.
        .ilike("address", userId)
        .is("removed_at", null)
        .maybeSingle();
      ownerId = (walletRow?.user_id as string) ?? null;
    }
    if (!ownerId) {
      return createSuccessResponse({ generations: [], total: 0, limit, offset });
    }

    // Images live in generated_images, not generations: the latter holds the
    // generation record (encrypted prompt, prompt_id NOT NULL) and has no image
    // column at all. Reading `generations` here is what made uploads invisible.
    const v = await viewer(supabase, req);
    let gallery = supabase
      .from("generated_images")
      .select("id, storage_url, preview_url, thumbnail_url, description, is_uploaded, created_at", { count: 'exact' })
      .eq("user_id", ownerId)
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);
    // Uploads are images nothing has checked yet: no 18+ mark, no child-safety
    // check (the image check is stage 2). Their owner sees them; nobody else
    // does until that check exists.
    // Images are recorded private; a visitor sees only what its owner published.
    if (v.userId !== ownerId) gallery = gallery.eq("is_uploaded", false).eq("visibility", "public");
    const { data, error, count } = await hideAdult(gallery, v, ownerId);

    if (error) {
      console.error('Database error:', error);
      return createErrorResponse('Failed to fetch generations', 500, error.message);
    }

    // Keep the shape the galleries already consume (image_url / prompt /
    // isUploaded) so this is a server-side fix with no client changes.
    const generations = (Array.isArray(data) ? data : []).map((row) => ({
      id: row.id,
      // image_url stays the ORIGINAL (downloads); image_urls is what the
      // galleries DISPLAY, so the WebP preview leads when one exists.
      image_url: row.storage_url,
      image_urls: (row.preview_url ?? row.storage_url) ? [row.preview_url ?? row.storage_url] : [],
      thumbnail_url: row.thumbnail_url ?? null,
      prompt: row.description ?? "",
      isUploaded: row.is_uploaded === true,
      created_at: row.created_at,
    }));

    return createSuccessResponse({
      generations,
      total: count || 0,
      limit,
      offset
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('Error fetching generations:', message);
    return createErrorResponse('Internal server error', 500);
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();

    // Validate request body
    const validation = validateBody(createGenerationSchema, body);
    if (!validation.success) {
      const errorMessages = validation.errors.map((err: any) => `${err.path.join('.')}: ${err.message}`);
      return createErrorResponse('Validation failed', 400, errorMessages);
    }

    const {
      userId,
      promptId,
      encryptedPrompt,
      variableValues,
      settings,
      transactionHash
    } = validation.data;

    // 2. Substitute variables
    const substitution = await substituteVariables(
      encryptedPrompt,
      variableValues,
      [] // TODO: Fetch variable definitions from prompts table when available
    );

    if (!substitution.success) {
      return createErrorResponse('Variable substitution failed', 400, substitution.errors);
    }

    // 3. Encrypt final prompt for storage
    const encryptedFinalPrompt = encryptPrompt(substitution.finalPrompt!);

    // 4. Prepare generation data
    const generationData = {
      user_id: userId,
      prompt_id: promptId,
      final_prompt: encryptedFinalPrompt.encryptedContent,
      variable_values: variableValues,
      settings: settings,
      transaction_hash: transactionHash || null,
      payment_verified: !transactionHash, // For now, assume free if no transaction hash
      amount_paid: null, // TODO: Get from prompt price when payment verification is implemented
      status: 'payment_verified', // TODO: Implement proper payment verification flow
      image_urls: [],
    };

    // 5. Store in database
    const supabase = getSupabaseServerClient();
    const { data, error } = await supabase
      .from('generations')
      .insert([generationData])
      .select('id, user_id, prompt_id, status, created_at')
      .single();

    if (error) {
      console.error('Database error:', error);
      return createErrorResponse('Failed to create generation', 500, error.message);
    }

    // Tell the prompt's creator their prompt was used — coalesces into one
    // counter row per prompt per day, so hot prompts can't flood the table.
    // (generations.user_id is a wallet address, not users.id, so a creator
    // generating with their own prompt is filtered via their linked wallets.)
    if (promptId) {
      try {
        const { data: prompt } = await supabase
          .from('prompts')
          .select('creator_id, title')
          .eq('id', promptId)
          .maybeSingle();
        if (prompt?.creator_id) {
          const { data: own } = userId
            ? await supabase
                .from('user_wallets')
                .select('address')
                .eq('user_id', prompt.creator_id)
                .eq('address', String(userId).toLowerCase())
                .is('removed_at', null)
                .maybeSingle()
            : { data: null };
          if (!own) {
            await notifyEvent(supabase, {
              userId: String(prompt.creator_id),
              kind: 'generation',
              title: `"${prompt.title ?? 'Your prompt'}" is being used`,
              body: 'Someone generated with it.',
              targetType: 'prompt',
              targetId: promptId,
            });
          }
        }
      } catch { /* notifications are best-effort */ }
    }

    // 6. Trigger async processing for payment-verified generations
    if (validation.data.transactionHash) {
      // For now, assume payment verification is handled elsewhere
      // TODO: Integrate with payment verification service (Phase 2C)
      console.log(`💳 Generation ${data.id} created with transaction hash: ${validation.data.transactionHash}`);

      // Mark as payment verified for now (will be replaced with real verification)
      await supabase
        .from('generations')
        .update({
          payment_verified: true,
          status: 'payment_verified',
          updated_at: new Date().toISOString()
        })
        .eq('id', data.id);

      console.log(`✅ Marked generation ${data.id} as payment verified`);
    } else {
      // Free generation - mark as payment verified and trigger processing
      console.log(`🆓 Free generation ${data.id} - marking as payment verified`);
      await supabase
        .from('generations')
        .update({
          payment_verified: true,
          status: 'payment_verified',
          updated_at: new Date().toISOString()
        })
        .eq('id', data.id);
    }

    // 7. Trigger background processing asynchronously
    // This will be picked up by the generation worker
    console.log(`🚀 Generation ${data.id} ready for background processing`);

    // 7. Return generation ID and status
    return createSuccessResponse({
      success: true,
      generationId: data.id,
      status: data.status,
      message: 'Generation created and variables substituted successfully'
    }, 201);

  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('Generation creation error:', message);
    return createErrorResponse('Internal server error', 500);
  }
}

// Get generation statistics
async function GET_STATS(req: Request) {
  try {
    const supabase = getSupabaseServerClient();

    const { data, error } = await supabase
      .from('generations')
      .select('id, status, created_at')
      .order('created_at', { ascending: false })
      .limit(1000);

    if (error) throw error;

    const stats = {
      total: data.length,
      byStatus: {
        pending: data.filter(g => g.status === 'pending').length,
        payment_verified: data.filter(g => g.status === 'payment_verified').length,
        generating: data.filter(g => g.status === 'generating').length,
        completed: data.filter(g => g.status === 'completed').length,
        failed: data.filter(g => g.status === 'failed').length,
      },
      recentActivity: data.slice(0, 10).map(g => ({
        id: g.id,
        status: g.status,
        createdAt: g.created_at
      }))
    };

    return createSuccessResponse(stats);
  } catch (error: any) {
    console.error('Error fetching generation stats:', error);
    return createErrorResponse('Failed to fetch statistics', 500);
  }
}

// Legacy support - redirect old API calls
export async function DELETE(req: Request) {
  return createErrorResponse("DELETE method not supported for enhanced generations API", 405);
}

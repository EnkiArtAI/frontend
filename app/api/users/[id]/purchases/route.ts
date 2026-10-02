/**
 * GET /api/users/[id]/purchases
 * Get buyer's purchased prompts and history
 */

import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { getPromptVariables } from "@/lib/prompts-db";
import { requireAuth } from "@/lib/auth";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: userId } = await params;

    let authUser;
    try {
      authUser = await requireAuth(request);
    } catch {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (authUser.walletAddress.toLowerCase() !== userId.toLowerCase()) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const supabase = getSupabaseServerClient();

    // Get user's purchases
    // Includes denormalized prompt_title and preview_image_url to prevent N+1 queries
    const { data: purchases, error: purchasesError } = await supabase
      .from('prompt_purchases')
      .select(`
        id,
        prompt_id,
        prompt_title,
        prompt_preview_image_url,
        seller_id,
        amount_usd_cents,
        transaction_hash,
        chain_name,
        status,
        created_at,
        completed_at
      `)
      .eq('buyer_id', userId)
      .eq('status', 'completed')
      .order('created_at', { ascending: false });

    if (purchasesError) {
      console.error('[API] Supabase error:', {
        code: purchasesError.code,
        message: purchasesError.message,
        details: purchasesError.details,
        hint: purchasesError.hint
      });
      
      // Handle missing table gracefully (PGRST205 = table not found)
      if (purchasesError.code === 'PGRST205' || purchasesError.message?.includes('schema cache')) {
        console.warn('[API] prompt_purchases table not found - returning empty purchases list');
        return NextResponse.json({
          userId,
          purchases: [],
          totalPurchases: 0,
          totalSpentCents: 0,
          summary: {
            totalPurchases: 0,
            totalSpent: 0,
            averagePurchase: 0,
            lastPurchase: null,
          }
        });
      }
      
      return NextResponse.json(
        { 
          success: false, 
          error: `Failed to fetch purchase history: ${purchasesError.message || 'Database error'}`,
          details: purchasesError.code || 'UNKNOWN'
        },
        { status: 500 }
      );
    }

    // Use denormalized data from purchases table (no N+1 queries!)
    // Only fetch additional data (variables) if needed, and only for non-deleted prompts
    const enrichedPurchases = await Promise.all(
      (purchases || []).map(async (purchase: any) => {
        // Use denormalized prompt_title from purchase record
        // This eliminates the N+1 query problem
        const promptTitle = purchase.prompt_title || '[Unknown Prompt]';
        const isDeleted = !purchase.prompt_title && purchase.status === 'completed';

        // Only fetch variables if prompt still exists (check by trying to get it)
        // We can optimize this further by denormalizing variables count if needed
        let variables: any[] = [];
        if (!isDeleted && purchase.prompt_id) {
          try {
            variables = await getPromptVariables(supabase, purchase.prompt_id);
          } catch (error) {
            // Prompt might be deleted - that's okay, variables will be empty
            console.warn(`Could not fetch variables for prompt ${purchase.prompt_id}:`, error);
          }
        }

        return {
          id: purchase.id,
          promptId: purchase.prompt_id,
          promptTitle: isDeleted ? '[Deleted Prompt]' : promptTitle,
          promptPreviewImageUrl: purchase.prompt_preview_image_url || null,
          sellerId: purchase.seller_id,
          sellerName: 'Creator', // Would need to fetch from users table
          amountCents: purchase.amount_usd_cents,
          transactionHash: purchase.transaction_hash,
          chainName: purchase.chain_name,
          purchasedAt: purchase.created_at,
          status: purchase.status,
          // A buyer pays for generations from a prompt, never for its text:
          // the artist's words stay encrypted and are only ever composed on the
          // server.
          content: null,
          variables: variables,
          isDeleted: isDeleted,
          consistencyIssue: isDeleted, // If title is missing, prompt might be deleted
        };
      })
    );

    // Calculate summary statistics
    const totalSpent = enrichedPurchases.reduce((sum, purchase) => {
      const amount = purchase.amountCents || 0;
      return sum + (typeof amount === 'number' ? amount : 0);
    }, 0);

    return NextResponse.json({
      userId,
      purchases: enrichedPurchases,
      totalPurchases: enrichedPurchases.length,
      totalSpentCents: totalSpent,
      summary: {
        totalPurchases: enrichedPurchases.length,
        totalSpent,
        averagePurchase: enrichedPurchases.length > 0 ? totalSpent / enrichedPurchases.length : 0,
        lastPurchase: enrichedPurchases.length > 0 ? enrichedPurchases[0].purchasedAt : null,
      }
    });

  } catch (error) {
    console.error('Error fetching user purchases:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json(
      { success: false, error: `Internal server error: ${errorMessage}` },
      { status: 500 }
    );
  }
}

import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The ways a user can get back into the account: a password and each
 * provider identity. A wallet row is not one of them (an embedded CDP wallet
 * is provisioned FROM a session, it cannot open one), so it is reported but
 * never counted. Throws on a real query error; a missing auth_identities
 * table reads as no identities, so the settings page still lists the rest.
 */
export type IdentityRow = {
  provider: string;
  handle: string | null;
  email: string | null;
  display_name: string | null;
  avatar_url: string | null;
  created_at: string | null;
};

export async function loginMethods(supabase: SupabaseClient, userId: string) {
  const [ids, cred, wallets] = await Promise.all([
    supabase.from("auth_identities").select("provider, handle, email, display_name, avatar_url, created_at").eq("user_id", userId),
    supabase.from("password_credentials").select("user_id").eq("user_id", userId).maybeSingle(),
    supabase.from("user_wallets").select("id").eq("user_id", userId).is("removed_at", null).limit(1),
  ]);
  if (cred.error) throw cred.error;
  if (wallets.error) throw wallets.error;
  const identities = (ids.error ? [] : (ids.data ?? [])) as IdentityRow[];
  const hasPassword = !!cred.data;
  return {
    identities,
    hasPassword,
    hasWallet: (wallets.data?.length ?? 0) > 0,
    loginMethodCount: identities.length + (hasPassword ? 1 : 0),
  };
}

-- A report that a prompt, image or profile involves a minor gets its own
-- reason, so the admin queue shows it first (2026-10-08). The CHECK accepted
-- obscene, impersonation, hate, spam, copyright and other (probed live; the
-- table held 0 rows), so this keeps those and adds child_safety.
alter table public.reports drop constraint if exists reports_reason_check;
alter table public.reports add constraint reports_reason_check
  check (reason in ('child_safety', 'obscene', 'hate', 'copyright', 'impersonation', 'spam', 'other'));

-- Nano Banana 2 (Google gemini-3.1-flash-image) as a catalogue row.
-- Live tables read 2026-10-06: models, model_providers (unique per model, role,
-- provider, provider_model), providers gemini + wavespeed active.
--
-- Step 1 can run any time: the model is created INACTIVE, nobody sees it.
-- Step 2 only after be/ENG-06-nb2 is deployed. Before that the price table has
-- no NB2 row (every quote for it fails) and Google would render every size at 1024².

-- ── Step 1: model and routes (inactive) ─────────────────────────────────
begin;

insert into models (name, price, allowed_ratios, active, max_reference_images, allowed_filetypes, media_type)
select 'Nano Banana 2', 0.045,
       array['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'],
       false, 14, array['image/png', 'image/jpeg', 'image/webp'], 'image'
where not exists (select 1 from models where name = 'Nano Banana 2');

-- Cheapest first: WaveSpeed Fast at 2K/4K ($0.045 / $0.05), Google direct at
-- 1K ($0.0672) and as the fallback, WaveSpeed standard last.
-- Boost = Google direct ($0.0672 / $0.1008 / $0.1512), the fastest host.
insert into model_providers (model_id, provider_id, provider_model, role, priority, applies_when, active)
select m.id, p.id, r.provider_model, r.role, r.priority, r.applies_when::jsonb, true
from models m
cross join (values
  ('wavespeed', 'google/nano-banana-2/text-to-image-fast', 'normal', 10, '{"resolution": ["2K", "4K"]}'),
  ('gemini',    'gemini-3.1-flash-image',                  'normal', 20, null),
  ('wavespeed', 'google/nano-banana-2/text-to-image',      'normal', 30, null),
  ('gemini',    'gemini-3.1-flash-image',                  'boost',  10, null)
) as r(provider_key, provider_model, role, priority, applies_when)
join providers p on p.key = r.provider_key
where m.name = 'Nano Banana 2'
  and not exists (
    select 1 from model_providers x
    where x.model_id = m.id and x.role = r.role and x.provider_id = p.id and x.provider_model = r.provider_model
  );

commit;

-- Check: 1 model row (active = false) and 4 routes.
--   select name, active, max_reference_images from models where name = 'Nano Banana 2';
--   select mp.role, mp.priority, p.key, mp.provider_model, mp.applies_when
--   from model_providers mp join providers p on p.id = mp.provider_id
--   join models m on m.id = mp.model_id where m.name = 'Nano Banana 2' order by mp.role, mp.priority;

-- ── Step 2: switch it on (after the deploy) ─────────────────────────────
--   update models set active = true where name = 'Nano Banana 2';

-- ── Nano Banana Pro: Google direct as the default (Kev, 2026-10-05) ─────
-- We charge Google's $0.134, but WaveSpeed ($0.14) runs first today. Google is
-- also the faster host, so with this normal = boost and the boost button goes away.
-- Independent of the deploy.
--   update model_providers mp set priority = case p.key when 'gemini' then 10 else 20 end
--   from providers p, models m
--   where p.id = mp.provider_id and m.id = mp.model_id
--     and m.name = 'Nano Banana Pro' and mp.role = 'normal';

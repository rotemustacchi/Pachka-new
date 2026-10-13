-- Values decided in the partner's answers to OPEN-QUESTIONS (13.10.2026).
--
-- Owner: shared (app_config), shipping (zones, rates)
--
-- Forward-only: see db/README.md. No down migration exists.

-- #16: the matchmaker shows three matches.
update app_config
   set value = '3'::jsonb,
       description = 'Maximum matches returned for a questionnaire. Decided: 3 (OPEN-QUESTIONS #16).'
 where key = 'matchmaker.result_count';

-- #6: the PACHKA return address. The postal code is still unknown, so it stays
-- a visible placeholder rather than a guessed number on a shipping label.
update app_config
   set value = '{"recipient": "PACHKA", "line1": "יגאל 13", "city": "חדרה", "postalCode": "PLACEHOLDER", "countryCode": "IL"}'::jsonb,
       description = 'The PACHKA-operated return address. Postal code still a PLACEHOLDER. Every return routes through it so that no artist address is printed on a shipping label.'
 where key = 'shipping.pachka_return_address';

-- #21: delivery to the whole country. The seeded zones covered postal prefixes
-- 1-3 and 5-9; 4 (the Sharon: Netanya, Kfar Saba, Ra'anana...) matched no zone
-- and blocked checkout.
insert into shipping_zones (code, display_name, cities, postal_prefixes)
values
  ('sharon', 'שרון',
   array['נתניה', 'כפר סבא', 'רעננה', 'הוד השרון', 'רמת השרון', 'כפר יונה', 'אבן יהודה',
         'netanya', 'kfar saba', 'raanana', 'hod hasharon', 'ramat hasharon', 'kfar yona', 'even yehuda'],
   array['4'])
on conflict (code) do nothing;

insert into shipping_rates (zone_id, tier_id, amount_agorot)
select z.id, t.id, 0
  from shipping_zones z cross join shipping_tiers t
 where z.code = 'sharon'
on conflict (zone_id, tier_id) do nothing;

-- #22-23: standard sizes ship free. Larger than every tier already needs an
-- individual quote (`requires_shipping_quote`), which is the "contact us" path.
-- Still a rate table, so an operator can put prices back without a deployment.
update shipping_rates set amount_agorot = 0;

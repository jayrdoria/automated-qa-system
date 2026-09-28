-- FR and IT moved from stakes.com to the stakes3.com mirror.
--
-- `brand` stores the DOMAIN id, so every historical FR/IT row is now filed
-- under a domain those markets are no longer tested against. Left alone, the
-- new stakes3 cells would start from "no data" and the duration medians that
-- drive the live progress bar would be thrown away.
--
-- Safe to re-run: the WHERE clause matches nothing after the first pass.
-- No unique-constraint collision is possible either — check_state is unique on
-- (brand, region, check_name) and check_run_progress on (brand, region), and
-- no stakes3 rows exist yet, so nothing can be updated onto an occupied key.
--
-- DE and ES are deliberately untouched: they stay on stakes.com.

UPDATE check_run
   SET brand = 'stakes3'
 WHERE brand = 'stakes'
   AND region IN ('FR', 'IT');

UPDATE check_state
   SET brand = 'stakes3'
 WHERE brand = 'stakes'
   AND region IN ('FR', 'IT');

UPDATE run_progress
   SET brand = 'stakes3'
 WHERE brand = 'stakes'
   AND region IN ('FR', 'IT');

-- game-load alert state goes back to ONE key per column ("game-load"), not one
-- per game. Games are only a rotation: the check's verdict is whatever the
-- latest run found, whichever game it tested — a failed run alerts, the next
-- passing run (any game) recovers it.
--
-- Collapses the per-game rows ("game-load:<game>") into a single row per
-- brand + region, carried over from the MOST RECENTLY UPDATED game so an
-- ongoing failure keeps its "failing since", streak and announced state, and
-- its recovery is still announced.
--
-- Idempotent: once collapsed no "game-load:%" rows remain, so both statements
-- match nothing on a second run. ON CONFLICT guards the (brand, region,
-- check_name) unique key should a "game-load" row already exist.

INSERT INTO check_state (id, brand, region, check_name, status, since, last_notified_at, fail_streak, updated_at)
SELECT DISTINCT ON (brand, region)
       'mig0009_' || md5(brand || ':' || region),
       brand, region, 'game-load', status, since, last_notified_at, fail_streak, updated_at
  FROM check_state
 WHERE check_name LIKE 'game-load:%'
 ORDER BY brand, region, updated_at DESC
ON CONFLICT (brand, region, check_name) DO NOTHING;

DELETE FROM check_state WHERE check_name LIKE 'game-load:%';

-- game-load now rotates between several games, and alerts wait for two
-- consecutive failures. Additive only: every statement is safe to run against a
-- live database and against a web build that does not yet know the columns.

-- Which game a game-load run tested. Nullable: older rows and every other check
-- have no target.
ALTER TABLE check_run ADD COLUMN IF NOT EXISTS target TEXT;

-- Consecutive failed runs per alert key, for the two-strike debounce.
ALTER TABLE check_state ADD COLUMN IF NOT EXISTS fail_streak INTEGER NOT NULL DEFAULT 0;

-- A check that is failing right now has, by definition, failed at least once.
-- Seeding 1 (not 0) means an ongoing failure keeps its existing alert behaviour
-- instead of looking brand new.
UPDATE check_state SET fail_streak = 1 WHERE status = 'fail' AND fail_streak = 0;

-- Alert state for game-load becomes per game, so one broken game cannot make
-- the check flap FAILING/RECOVERED as the rotation moves on. Everything recorded
-- before rotation was Wanted Dead or a Wild — the only game there was — so its
-- state is carried over under that name rather than orphaned.
--
-- Idempotent (matches nothing on a second run) and collision-free (no row with
-- the new name can exist before rotation ships).
UPDATE check_state
   SET check_name = 'game-load:wanted-dead-or-a-wild'
 WHERE check_name = 'game-load';

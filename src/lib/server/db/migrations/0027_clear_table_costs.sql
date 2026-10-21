-- AFB-20261021-0652: COSTS WORKED OUT FROM THE PRICE TABLE ARE CLEARED, SO NO TOTAL EVER SHOWS A FIGURE THAT CAME FROM A TABLE
-- computed rows were priced by the board; estimated rows may have been repriced from the table and cannot be told apart from a cost the agent gave.
-- Forced row level security binds the owner role on the live database (it is not a superuser), so it is lifted for this one statement and forced again.
ALTER TABLE "usage_event" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
UPDATE "usage_event" SET "cost_micros" = NULL, "cost_source" = 'unpriced' WHERE "cost_source" IN ('computed', 'estimated');--> statement-breakpoint
-- The migration proves its own result, while the owner can still see every row: it fails, and nothing is recorded, when a row still carries a worked out cost
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM "usage_event" WHERE "cost_source" IN ('computed', 'estimated')) THEN
		RAISE EXCEPTION 'usage_event still holds computed or estimated rows after the clean up';
	END IF;
END $$;--> statement-breakpoint
ALTER TABLE "usage_event" FORCE ROW LEVEL SECURITY;

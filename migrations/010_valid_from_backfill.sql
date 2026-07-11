-- G4: activate the temporal validity fields (idle since 001). valid_from is
-- the moment a belief started holding. Existing rows predate the write path,
-- so backfill once from created_at.
UPDATE facts SET valid_from = created_at WHERE valid_from IS NULL;

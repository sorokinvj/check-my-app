-- CHE-198: a step our checker could not verify names the capability it ran
-- into. Decided at report time from the model's own words and the machine
-- trail (src/agent/gap-classes.ts), before the customer-copy scrub (CHE-180)
-- cuts the words the filer used to guess from — run #154's new-tab link and
-- run #153's slider both fell into the unclassified bucket that way. The
-- gap filer reads this column; it re-derives a class only for rows that
-- predate it. NULL unless unverifiedReason = 'our_capability'.

ALTER TABLE "Step" ADD COLUMN "gapClass" TEXT;

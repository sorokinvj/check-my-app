-- Demo verdict for D1 (CHE-11+13 render verification). Mirrors prisma/seed.ts
-- but as direct SQL since Prisma's Node seed can't talk to D1. JSON columns are
-- TEXT. Idempotent: deletes the demo run/watch first.
DELETE FROM "Run" WHERE "appSlug" = 'joblander.app';
DELETE FROM "Watch" WHERE "appSlug" = 'joblander.app';
INSERT OR REPLACE INTO "Counter" ("name","value") VALUES ('runNumber', 1);

INSERT INTO "Run" (
  "id","publicId","runNumber","targetUrl","appSlug","notifyEmail","status","verdict",
  "bottomLine","appLens","anatomy","events","startedAt","completedAt","createdAt","updatedAt"
) VALUES (
  'demo-run-1','demo-verdict',1,'https://joblander.app','joblander.app','vlad@example.com',
  'completed','mostly_ok',
  'Core product works and feels coherent — but mobile signup is broken and the AI coach has no rate limit.',
  '{"oneLiner":"joblander.app is an AI-powered interview prep platform for job seekers practicing technical and behavioral interviews.","whoFor":"people preparing for software engineering interviews","coreValue":"practice mock interviews with AI coaches, get feedback","businessModel":"freemium SaaS — paid tier unlocks more sessions","techSurface":"Next.js web app + Chrome extension companion","criticalPaths":["Sign up → first mock interview (activation)","Mock interview → AI coach feedback (core loop)","Free → paid conversion (revenue)"],"ifItBreaks":"lost signups, AI cost abuse, mid-session churn"}',
  '{"pages":["/","/signup","/login","/dashboard","/interview/new","/mock/start","/interview/{id}","/coach","/pricing","/settings","/profile","/admin","/api/health","/404"],"actions":["Sign up","Log in","Log out","Start mock interview","Choose role","Record audio answer","Get coach feedback","Browse pricing tiers"],"services":[{"name":"Stripe","role":"payment processing"},{"name":"Supabase","role":"auth + database"},{"name":"Posthog","role":"analytics"},{"name":"Anthropic API","role":"AI coach (Claude)"},{"name":"Cloudflare R2","role":"audio recording storage"}],"tech":{"frontend":"Next.js 14 (App Router) · Tailwind · shadcn","hosting":"Vercel","auth":"Supabase Auth","realtime":"WebSockets"}}',
  '[{"at":"2026-05-02T14:32:00.000Z","phase":"writing","icon":"ok","text":"Verdict written"}]',
  '2026-05-02T14:32:00.000Z','2026-05-02T16:46:00.000Z','2026-05-02T14:32:00.000Z','2026-05-02T16:46:00.000Z'
);

INSERT INTO "Journey" ("id","runId","order","title","status","summary") VALUES
 ('j1','demo-run-1',0,'Sign up → first mock interview','broken','signup fails on Safari mobile (~18% of your traffic)'),
 ('j2','demo-run-1',1,'Mock interview → AI coach feedback','risky','audio cuts at 30s consistently. Coach has no rate limit (could be abused).'),
 ('j3','demo-run-1',2,'Free → paid (browse pricing)','confusing','pricing page shows 4 tiers but two CTAs go to the same checkout.');

INSERT INTO "Step" ("id","journeyId","order","label","status","observed") VALUES
 ('s1','j1',0,'Land on homepage','ok','Homepage loaded in 1.2s'),
 ('s2','j1',1,'Click "Get started"','ok','Signup form appeared'),
 ('s3','j1',2,'Enter email + password','ok','Fields validated inline'),
 ('s4','j1',3,'Verify email','risky','Took 94s to arrive'),
 ('s5','j1',4,'Try mock interview on iPhone → 500','broken','POST /api/auth/signup → 500 FUNCTION_INVOCATION_TIMEOUT'),
 ('s6','j1',5,'(couldn''t reach this step)','skipped',NULL),
 ('s7','j2',0,'Login','ok',NULL),
 ('s8','j2',1,'Dashboard','ok',NULL),
 ('s9','j2',2,'"Start Mock Interview"','ok',NULL),
 ('s10','j2',3,'Speak answer — audio cuts at 30s','risky','Recording stopped at 30s, no error shown');

INSERT INTO "Finding" ("id","runId","number","title","category","severity","detail","mark","createdAt") VALUES
 ('f1','demo-run-1',1,'Sign up returns 500 on Safari mobile','broken','high','{"where":"POST /api/auth/signup → 500","browser":"Mobile Safari (iPhone 14)","reproduced":3,"whatHappened":"500 FUNCTION_INVOCATION_TIMEOUT after 10s","whyItMatters":"~18% of mobile traffic is iOS Safari — they cannot sign up. Acquisition leak."}','none','2026-05-02T16:46:00.000Z'),
 ('f2','demo-run-1',2,'AI coach endpoint has no rate limit','exposed','high','{"where":"POST /api/coach/feedback","whatHappened":"60 req/min accepted from one session, no 429","whyItMatters":"Anthropic API cost abuse: a script could burn the monthly budget overnight."}','none','2026-05-02T16:46:00.000Z'),
 ('f3','demo-run-1',3,'Mock interview audio cuts at 30s','broken','medium','{"where":"MediaRecorder /mock/session","whatHappened":"Recording silently stops at 30.0s","whyItMatters":"Answers over 30s are truncated — core loop degrades invisibly."}','none','2026-05-02T16:46:00.000Z'),
 ('f4','demo-run-1',4,'Pro and Team tiers list identical features','confusing','low','{"where":"/pricing","whyItMatters":"Users cannot tell what they pay more for."}','none','2026-05-02T16:46:00.000Z');

# Freemeans PRD: "Free for who you are" (eligibility-based offers)

**Status:** approved direction, Module 1 built · **Date:** 9 Nov 2026 · **Owner:** Waqas Ahmad
**Builds on:** the live catalog (`data/catalog/seed.json`, `packages/schema/`), the API (`services/api`), the nightly source check (`services/pipeline`), and the SEO rules in `docs/SEO.md`.

---

## Chapter 1. The problem

Some free offers exist only for certain people: students, teachers, nonprofits, startups, or people in one country. They are often worth more than any public free tier. Examples: US$100 of Azure every year, a free GitHub Team plan, a free year of Google AI Plus, up to US$10,000 a month of Google search ads.

People miss them for two reasons:

1. **Nobody tells them who qualifies.** The rules are spread across help pages ("accredited", "WHED-listed school email", "501(c)(3) or equivalent", "K-12 only").
2. **Most lists online are out of date.** While checking offers for this PRD, five popular claims turned out to be wrong or expired:

| What people still repeat | What is true on 9 Nov 2026 | Source |
| --- | --- | --- |
| "Students get Copilot **Pro** free" | Students get a separate **Copilot Student** plan: free, with auto model selection only and an allowance of AI credits. Free Copilot **Pro** is for verified *teachers* and maintainers of popular open-source projects | docs.github.com/en/copilot/get-started/plans |
| "AWS Educate gives students free credits" | Educate stopped giving credit grants in Feb 2023. It is now free training and labs, with no card needed | AWS Builder Center (2026) |
| "Nonprofits get 10 free Microsoft 365 Business Premium seats" | That grant ends at each nonprofit's first renewal on or after 1 July 2025. The free grant is now **Business Basic, up to 300 users**, plus US$2,000 a year of Azure credits | learn.microsoft.com (nonprofit updates) |
| "Canva Education is free for university students" | Canva Education is only for **K-12** teachers and their students. Universities are excluded | canva.com/education/eligibility-guidelines |
| "Google AI **Pro** is free for students everywhere" | Since Aug 2026, AI **Pro** for students is US-only. Students in 140+ other markets get **AI Plus** free for 12 months instead (redeem by 31 Dec 2026, card required, paid after the year unless cancelled) | gemini.google/students; one.google.com student offer terms |

**What Freemeans adds:** every offer says who qualifies, in which countries, what proof is needed, when it ends, and what it costs afterwards. Each fact carries a date and a source, and the nightly check re-reads those sources.

---

## Chapter 2. Who it is for

Pakistan comes first: it is the owner's own market, and almost nobody covers it.

| Persona | Typical question | What they need from us |
| --- | --- | --- |
| **University student in Pakistan** (e.g. a UAF BSCS student) | "What can I get free with my student status?" | One list filtered to *higher-ed student + PK*, with notes on whether `.edu.pk` email works and whether a card is needed |
| **University lecturer** | "What can I use in my class for free?" | Teacher offers (Copilot Pro, JetBrains, Autodesk), plus institution offers to forward to the IT office (Workspace for Education, Office 365 A1, JetBrains Classroom) |
| **NGO or society admin** | "We are registered. What tech do we get free?" | Nonprofit stack: Google for Nonprofits, Microsoft Business Basic and Azure, GitHub Team, Canva Pro (50 seats), Cloudflare Galileo, plus the documents each one asks for |
| **Early founder** (no investors) | "Which cloud credits can I get without a VC?" | Startup offers split into *self-funded* and *investor-referred* |
| **School teacher (K-12)** | "Free tools for my classroom?" | Canva Education, Figma (K-12 Enterprise), Office 365 A1. ChatGPT for Teachers is shown as **US only** |

---

## Chapter 3. Scope

**In v1**
- 5 audience groups: students, teachers, institutions, nonprofits, startups.
- Countries: offers marked *global*, *only these countries* or *everywhere except these countries*. Pakistan pages ship first.
- 30 verified seed offers (Chapter 7).
- An eligibility checker. The visitor picks who they are and their country and sees their list. It runs in the browser and stores nothing.
- An "Ending soon" list and a "Myths" page (Chapter 5).

**Not in v1**
- Verifying anyone's status. We link to the provider's own verification.
- Tracking usage of these offers. That stays with the API-tier quota tracker.
- Urdu pages (planned as `/ur/`, see `docs/SEO.md`, Chapter 7).

**Firm rule: no workarounds.** Freemeans never explains how to get around eligibility: no fake student IDs, VPN tricks for country offers, multiple accounts or "free .edu email" services. This is the same policy as `manual_only` for Colab. It protects users from bans, and it protects the site's standing with Google and with the providers.

---

## Chapter 4. Data model

### 4.1 New optional fields on a resource

The present `resource.schema.json` has `additionalProperties: false`, so these fields must be added to the schema. Existing records need no change, because every new field is optional.

```jsonc
{
  "id": "google.ai-plus-student",
  "provider": "Google",
  "name": "Google AI Plus, 12 months free for students",
  "kind": "ai_subscription",            // new kind (4.2)
  "tier_type": "trial",                 // free for 12 months, then paid
  "status": "active",                   // active | paused | ended | unverified
  "eligibility": {
    "audiences": ["student_higher_ed"], // enum (4.3)
    "countries": { "mode": "exclude", "codes": ["US", "CA", "HK", "MO", "BO", "AL", "TN"] }, // ISO 3166-1 alpha-2; example only — copy the full list from Google's support page in M2
    "min_age": 16,
    "via": "individual",                // individual | institution
    "proof": ["sheerid", "school_email"],
    "verifier": "SheerID",
    "reverify": "yearly",               // none | monthly | yearly | on_renewal
    "excludes": "School-issued Google accounts; people with an active Google One plan",
    "notes": "Pakistan is covered. Some Pakistani universities' .edu.pk addresses may need SheerID document upload."
  },
  "offer_window": {
    "redeem_by": "2026-12-31",
    "duration_months": 12,
    "after": { "price": "about US$4.99/month or local price", "auto_renews": true }
  },
  "limit_rules": [],
  "badges": [
    { "type": "payment_method_required", "source_url": "https://one.google.com/offer/studentoffer8" },
    { "type": "auto_renews_paid", "note": "Charged after 12 months unless cancelled", "source_url": "https://one.google.com/offer/studentoffer8" }
  ],
  "watch": [                            // phrases the source check expects to find (Chapter 6)
    { "text": "December 31, 2026", "source_url": "https://one.google.com/offer/studentoffer8" }
  ],
  "last_verified": "2026-11-09",
  "sources": [ /* as today */ ]
}
```

### 4.2 New enum values

| Field | Today | Add |
| --- | --- | --- |
| `kind` | llm_api, speech_api, embedding_api, inference_platform, gpu_notebook, cloud_credit | `ai_subscription`, `software_license`, `saas_plan`, `dev_platform`, `course`, `certification`, `library_access`, `security_service`, `ad_grant` |
| `badges.type` | 7 types | `auto_renews_paid` (charged after the free period unless cancelled) and `educational_use_only` (stricter than `non_commercial`, e.g. Autodesk) |
| `limit_rules.metric` | 12 metrics | `seats` (Canva 50, Microsoft 300, Autodesk 250) |
| `limit_rules.window` | second … one_time | `year` (Azure for Students: US$100 per 12 months) |

### 4.3 Audience enum

`student_k12`, `student_higher_ed`, `student_bootcamp`, `educator_k12`, `educator_higher_ed`, `institution_school`, `institution_university`, `nonprofit`, `startup_self_funded`, `startup_investor_backed`, `open_source_maintainer`, `researcher`, `journalist_civil_society`, `resident` (anyone in the listed countries, e.g. a national promotion), `public` (anyone at all, for future free courses, Chapter 11).

Each page groups these into the five audience groups from Chapter 3. For example, *students* covers `student_k12`, `student_higher_ed` and `student_bootcamp`.

### 4.4 Database: eligibility migration

> **Note (10 Nov 2026):** the M1 branch names this file `003_eligibility.sql`, but `main` already has `003_review_queue.sql` from the directory work. When rebasing, rename it to **`004_eligibility.sql`**.

- Widen the CHECK constraints on `resources.kind`, `badges.type`, `limit_rules.metric` and `limit_rules."window"`.
- Add `status text NOT NULL DEFAULT 'active'`, `redeem_by date`, `access_ends date`, `audiences text[] NOT NULL DEFAULT '{}'`, `country_mode text NOT NULL DEFAULT 'global'` and `countries text[] NOT NULL DEFAULT '{}'`, with GIN indexes on `audiences` and `countries`.
- New table `watch_phrases`, and a view `resources_live` whose `effective_status` turns to `ended` once `redeem_by` or `access_ends` has passed.
- The full record stays in `resources.record` (JSONB), as it does now.
- A DB test checks that every SQL CHECK list matches the JSON Schema enums exactly.

### 4.5 API (`services/api/src/catalog.js`)

| New parameter | Meaning |
| --- | --- |
| `audience=student_higher_ed,educator_higher_ed` | Any of these audiences |
| `group=students` | Shorthand for an audience group |
| `country=PK` | Offers that are global, include PK, or exclude other countries but not PK |
| `status=active` (default) / `include_ended=true` | Ended offers are hidden unless asked for |
| `ending_within_days=60` | For the "Ending soon" list |

**Status at read time:** if `redeem_by` is past, the API reports `ended`, whatever the stored status says. A missed rebuild can never show an expired offer as live.

---

## Chapter 5. Pages and URLs

These follow the rules in `docs/SEO.md`, Chapter 6: one `<h1>` per page, a unique description of 50–170 characters, JSON-LD, every page in `sitemapEntries()`, and filters never indexed.

| Page | URL | Index? |
| --- | --- | --- |
| Hub: "Free for who you are" | `/free-for/` | Yes |
| Audience pages | `/free-for/students/`, `/free-for/teachers/`, `/free-for/nonprofits/`, `/free-for/startups/`, `/free-for/institutions/` | Yes |
| Audience × country | `/free-for/students/pakistan/`, etc. | Yes, **only when 5 or more offers are active** (same thin-content rule as categories). Otherwise `noindex` |
| Country hub | `/in/pakistan/` (every free offer usable from Pakistan, including public free tiers) | Yes |
| Ending soon | `/free-for/ending-soon/` (redeem-by date within 60 days) | Yes. Rebuilt daily |
| Myths | `/free-for/myths/` (expired and misreported offers, with what replaced them) | Yes. This is the page people will link to |
| Offer detail | existing `/resources/{id}/`, with a new **"Who can get this"** box at the top | Yes |
| Checker | `/free-for/?who=…&country=…` | No (query strings) |

**"Who can get this" box (on every offer page):** who · countries · proof needed · card needed? · how long · what it costs afterwards · re-verification · "Checked on {date}" with the source link.

**Structured data:** reuse `webPageLd` with `about: { '@type': 'Service', offers: { '@type': 'Offer', price: 0, eligibleRegion: [Country…], availabilityEnds: redeem_by } }`. Audience pages also get `audience: { '@type': 'EducationalAudience', educationalRole: 'student' }` (or `'teacher'`) and an `ItemList`.

**Titles:** put the date in the title, e.g. *"Free tools for students in Pakistan (November 2026)"*, 70 characters or fewer.

**Timing:** the Google AI Plus student offer must be redeemed by 31 Dec 2026, so searches for it in Pakistan will peak in December. Ship `/free-for/students/pakistan/` and `/free-for/ending-soon/` by **mid-December**.

---

## Chapter 6. Keeping it true

These offers change more often than API limits do. Four mechanisms keep them current:

1. **Watch phrases.** Each offer lists 1–3 short phrases that must still appear on the source page: a date ("December 31, 2026"), an amount ("$100"), or a condition ("no credit card"). The source check (`services/pipeline/source_check/check.py`) gets a `find_phrase()` beside `find_limit()` and reuses the same statuses (`confirmed`, `missing`, `unreachable`). A missing phrase goes into the same weekly-style pull request.
2. **Expiry by date.** Once `redeem_by` is past, the API marks the offer ended (4.5). Each page also runs a small script that compares today with `redeem_by` and shows an "Ended" label. A scheduled GitHub Action rebuilds the site daily, so the "Ending soon" list and the sitemap's `<lastmod>` stay current.
3. **Staleness flag.** The run Summary lists any offer whose `last_verified` is more than 60 days old under *Re-check by hand*.
4. **Myths feed.** When an offer ends, keep the record with `status: ended` and a `replaced_by` pointer instead of deleting it. The Myths page is built from these records.

---

## Chapter 7. Seed list: 30 offers (checked 9 Nov 2026)

**Confidence:** **A** = read on the provider's own page today. **B** = provider page plus reliable press, but one detail still needs confirming before publishing (noted). Nothing in this list relies on a single unofficial blog.

### Students

| # | id | Offer | Who / where | Proof · card | Window | Conf. |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `github.copilot-student` | Copilot Student plan: free, auto model selection, monthly allowance of AI credits | Verified students, global | GitHub Education verification · no card | While verified (GitHub re-checks eligibility monthly) | A |
| 2 | `github.student-pack` | GitHub Pro plus partner offers | Verified students, global | GitHub Education · no card | While a student | A |
| 3 | `microsoft.azure-for-students` | US$100 Azure credit for 12 months, renewable each year | Full-time university students | School email · **no card** | Yearly renewal while a student | A |
| 4 | `microsoft.azure-students-starter` | Limited Azure services, no time limit | High-school / secondary students | No card | No end | A |
| 5 | `jetbrains.education-pack` | All JetBrains IDEs | Students and teachers at accredited schools and universities, programs of 1 year or more | University email, ISIC/ITIC card, official document or GitHub Pack · **not for commercial work** | 1 year, renewable | A |
| 6 | `notion.education-plus` | Notion Plus free (one-member workspace), 50% off Notion AI | College and university students and educators; **not K-12** | School email recognized via WHED · no card | While the account keeps the school email | A |
| 7 | `figma.education` | Figma Professional free (higher education); Enterprise through the school (K-12) | Students and educators | School email + SheerID | 1 year, then re-verify | A |
| 8 | `autodesk.education` | AutoCAD, Revit, Fusion, Maya and others | Students and educators at qualified institutions | School email verification · **educational use only** | 1 year, renewable | A |
| 9 | `google.ai-plus-student` | Google AI Plus: higher Gemini limits, 400 GB storage | Higher-ed students in 140+ markets outside the US, **including Pakistan** | SheerID, personal Google account · **card required, auto-renews (~US$4.99/month)** | **Redeem by 31 Dec 2026**, 12 months | B: confirm PK on Google's country list and the minimum age (16+ reported) |
| 10 | `google.ai-pro-student-us` | Google AI Pro, 12 months | US college students aged 18+ | SheerID · card required, US$19.99/month afterwards | Redeem by 31 Dec 2026 | A |
| 11 | `cursor.pro-student` | Cursor Pro, 1 year | "Eligible university students"; reports say the list is now narrower (.edu, listed countries) | SheerID · card for renewal | 1 year | B: confirm the country list; mark `unverified` until then |
| 12 | `aws.educate` | Free cloud and AI training, labs, badges (**no credits since 2023**) | Learners aged 13+, global | Email only · no card | No end | A |
| 13 | `microsoft.office365-a1` | Office 365 A1: web Word, Excel, PowerPoint, Teams | Students and educators at eligible institutions | School email | While enrolled or employed | A |
| 14 | `canva.education` | Canva Pro features free | **K-12 only**: teachers, and students invited by their teacher | Teaching documents | Re-verify periodically | A |

### Teachers and institutions

| # | id | Offer | Who / where | Proof · card | Window | Conf. |
| --- | --- | --- | --- | --- | --- | --- |
| 15 | `github.copilot-pro-teachers` | Copilot Pro free | Verified teachers (GitHub: "may be eligible") | GitHub Education teacher verification | While verified | A |
| 16 | `openai.chatgpt-for-teachers` | ChatGPT for Teachers workspace | **Verified US K-12 educators only** | SheerID | Free through June 2027 | A |
| 17 | `google.workspace-edu-fundamentals` | Gmail, Classroom, Drive, Meet, Gemini app, NotebookLM | Qualifying schools and universities (institution applies) | Institution verification | No end | A |
| 18 | `jetbrains.classroom` | Classroom licenses for all JetBrains IDEs | Accredited institutions | Teacher or IT role document | Renewable | A |
| 19 | `autodesk.educator-plan` | 250 named-user seats for a class | Educators at qualified institutions | Educator verification | 1 year, renewable | A |

### Nonprofits

| # | id | Offer | Who / where | Proof · card | Window | Conf. |
| --- | --- | --- | --- | --- | --- | --- |
| 20 | `google.for-nonprofits` | Workspace for Nonprofits, Ad Grants (up to US$10,000/month in search ads), YouTube Nonprofit | Registered charities in 65+ countries, **Pakistan listed** | Registered charity status, checked by Google's validation partner | Ongoing (Ad Grants has its own activity rules) | A |
| 21 | `microsoft.nonprofits` | Microsoft 365 Business Basic grant (up to 300 users), US$2,000 of Azure credits a year | Eligible nonprofits | Nonprofit verification · grant seats for paid staff and leadership | Yearly | A |
| 22 | `github.nonprofits` | GitHub Team plan free | Nonprofits that are non-governmental, non-academic, non-commercial, non-political and not religiously affiliated | Proof of nonprofit status | Ongoing | A |
| 23 | `canva.nonprofits` | Canva Pro for one team of up to 50 | Registered nonprofits, 190+ countries | Goodstack verification | Ongoing | A |
| 24 | `cloudflare.project-galileo` | Business-level security (DDoS, WAF), Zero Trust | Human-rights, civil-society, journalism and democracy organizations | Application reviewed with partner NGOs | Ongoing | A |

### Startups

| # | id | Offer | Who / where | Proof · card | Window | Conf. |
| --- | --- | --- | --- | --- | --- | --- |
| 25 | `aws.activate-founders` | US$1,000 AWS credits (some get up to US$5,000) | Self-funded, founded within 10 years, working website | Company details · AWS paid-tier account | Credits expire | A |
| 26 | `google.startups-cloud` | Start tier up to about US$2,000; funded AI startups up to US$350,000 over 2 years | Startups founded within 10 years, under US$5,000 previous credits | Company domain; funding proof for higher tiers | 1–2 years | B: confirm the Start-tier amount on cloud.google.com |
| 27 | `microsoft.startups` | Self-serve Azure credits (about US$5,000); investor-referred path higher | For-profit startups in supported countries | Business verification; referral code for the investor path | Time-limited | B: amounts come from secondary guides |

### Pakistan

| # | id | Offer | Who / where | Proof · card | Window | Conf. |
| --- | --- | --- | --- | --- | --- | --- |
| 28 | `digiskills.dstp3` | Free online courses with e-certificates (MoITT, Ignite, Virtual University) | Anyone in Pakistan with Matric or higher | Online sign-up · free | **Batch-05: enrolment opened 2 Nov 2026 (first come, first served), classes start 1 Dec 2026** | A |
| 29 | `hec.digital-library` | Journals, databases, e-books | Students, faculty and staff of HEC-recognized universities and R&D bodies; **individuals cannot apply** | Campus network (IP) or the university's VPN/credentials | Ongoing | A |
| 30 | `mofept.cisco-netacad` | Free online technology courses (Ministry of Federal Education with Cisco Networking Academy) | Students in Pakistan | Sign-up | Launched Feb 2026 | B: one press source; find the official page |

`google.ai-plus-student` (#9) also appears on every Pakistan page, because Pakistan is one of its countries.

### Myths page, first entries (`status: ended`)

GitHub Copilot Pro for students (replaced by Copilot Student, Mar 2026) · AWS Educate credit grants (ended Feb 2023) · Microsoft 365 Business Premium nonprofit grant (ends at the first renewal after 1 Jul 2025) · Google AI Pro free for students outside the US (2025 offer; people who claimed it keep it until their period ends) · ChatGPT Go free for 12 months in India (promotion from 4 Nov 2025; check whether it has ended before listing).

---

## Chapter 8. Build plan

Each module ends with green CI. The owner says "next" for each one.

| Module | Work | Done when |
| --- | --- | --- |
| **M1 Schema** ✅ merged | Add `eligibility`, `offer_window`, `status`, `watch` and the new enums to `packages/schema/`; write the eligibility migration; update `db/load-seed` | Old records still validate, the 30 new ones validate, and the migration runs on Neon |
| **M2 Seed data** ✅ merged | `data/catalog/eligibility.json` (kept apart from the API-tier `seed.json`; both loaded together) with the 30 offers and the Myths records | Every record has at least one source with a date; B-confidence records start as `unverified` |
| **M3 API** ✅ merged | `audience`, `group`, `country`, `status`, `ending_within_days`; status worked out at read time | Tests for country include/exclude logic and expiry |
| **M4 Pages** ✅ merged | `/free-for/…`, `/in/pakistan/`, the "Who can get this" box, the checker, JSON-LD, sitemap | `npm test` build guards pass; Rich Results Test shows valid breadcrumbs |
| **M5 Freshness** ✅ merged | `find_phrase()` in the source check; daily rebuild Action; staleness list | One full nightly run with watch phrases, shown in the Summary |
| **M6 Launch** (checklist and post drafts: `docs/ELIGIBILITY-LAUNCH.md`) | Ship the PK student page and Ending soon by mid-December; share with UAF students; one dev.to/LinkedIn post: "Free things Pakistani students qualify for and nobody tells them" | Pages indexed in Search Console |

M1–M4 are the critical path for the December deadline.

---

## Chapter 9. Risks

| Risk | Handling |
| --- | --- |
| Offers change or end without notice | Watch phrases, expiry by date, the 60-day staleness list, and a visible "Checked on" date on every offer |
| Users get charged after a free year (Google AI Plus, Cursor) | `auto_renews_paid` badge shown in red, plus "Set a reminder to cancel" text with the renewal date |
| Pakistani `.edu.pk` addresses fail automatic checks | Say so honestly in `eligibility.notes`; link to the provider's document-upload route. Never suggest workarounds |
| Pages look like spam ("free Pro!!") | Plain titles, real conditions first, a Myths page that corrects other sites |
| Paid placements later | Same as `docs/SEO.md`, 6.3: `rel="sponsored"`, a visible label, and never inside the eligibility lists |

---

## Chapter 10. Decisions

| # | Question | Decision |
| --- | --- | --- |
| 1 | One catalog file or two? | **Two.** `data/catalog/eligibility.json` sits beside `seed.json`. The DB loader merges both, so the agent's API-tier catalog stays clean (built in M1) |
| 2 | Offers that need a card and start charging after the free period (e.g. Google AI Plus) | **Listed, with a red warning badge** (decided 9 Nov 2026). Badge `auto_renews_paid`, label "Charges after free period", tone `stop` (red). CI rejects any offer with `offer_window.after.auto_renews = true` that lacks the badge, and the reverse (built in M1) |
| 3 | K-12 audiences in v1? | **Yes, labelled clearly** (decided 12 Nov 2026) |
| 4 | Urdu summary block on `/free-for/students/pakistan/` now? | **No. Wait for the planned `/ur/` pages** (decided 12 Nov 2026) |
| 5 | Keep `/free-for/ending-soon/` indexed when it lists few offers? | **Yes** (decided 12 Nov 2026). It is `noindex` only when empty |
| 6 | Which audiences make up the "nonprofits" group? | **`nonprofit` and `journalist_civil_society`** (decided 12 Nov 2026). `open_source_maintainer`, `researcher`, `resident` and `public` belong to no group |

## Chapter 11. Next scope: free learning (trainings, certificates, courses, specializations)

**Decided 9 Nov 2026:** Freemeans will later list free learning offers for students, teachers and the general public. Examples include DigiSkills.pk, Google and Microsoft skills programs, AWS Skill Builder, Coursera Financial Aid and university MOOCs.

**Already supported by M1**, so no schema break is needed later:
- kinds `course` and `certification`
- audience `public` (anyone), beside the student and educator audiences
- `offer_window` for enrolment windows and batch dates (e.g. DigiSkills Batch-05: enrol from 2 Nov, starts 1 Dec 2026)
- watch phrases for batch and deadline text

**The `learning` block** (built in L1; schema in `packages/schema/learning.schema.json`; `language` became a list, `languages`, because one course can be offered in several):

| Field | Why people need it |
| --- | --- |
| `format`: self_paced, cohort, live, in_person | Cohorts have enrolment deadlines; self-paced courses do not |
| `hours`, `level` (beginner, intermediate, advanced) | The first two filters people use |
| `language`: en, ur, … | Urdu courses are a niche few others cover |
| `certificate`: none, free, paid_optional, paid_required | The most common trap: "free course" but the certificate costs money |
| `credential`: completion, badge, professional_certificate, specialization, accredited_credit | Separates a completion PDF from an industry certificate |
| `exam_voucher`: free or discounted exam vouchers | Some programs give free certification exam vouchers (e.g. after a skills challenge) |
| `roles`: target roles (e.g. data analyst, cloud engineer, teacher) | Enables pages such as "free certificates for teachers" and "free cloud certificates for students in Pakistan" |

**Pages then:** `/learn/`, `/learn/certificates/`, `/learn/for/teachers/`, `/learn/pakistan/`, plus "Free certificate, not just free course" filters. The thin-content rule (5+ active items) and the no-workarounds rule apply as before.

**Honesty rule specific to learning:** a course counts as free only if the learning is free. Show `certificate: paid_required` with a warning badge, just like `auto_renews_paid`. Built as the amber badge `paid_certificate` ("Certificate costs money"). CI rejects a `paid_required` course without the badge, and the badge on any other course.

### 11.1 Build plan

Each module ends with green CI. The owner says "next" for each one. Branches are named `learning/l1-schema` and so on.

| Module | Work | Done when |
| --- | --- | --- |
| **L1 Schema** ✅ merged | `learning` block, badge `paid_certificate`, migration `005_learning.sql`, rule "a course or certification needs a `learning` block unless it is unverified or ended", rule "`paid_required` needs the badge, both ways", example file, tests | Old records still validate, the two active courses (`digiskills.dstp3`, `aws.educate`) carry a `learning` block, the DB CHECK list matches the schema |
| **L2 Seed data** ✅ built | `data/catalog/learning.json` (a third file, loaded with the other two): 10 records, 9 active and 1 unverified. IBM SkillsBuild, Harvard CS50x, Microsoft Learn, AWS Skill Builder, Google Skills Starter, Cisco Networking Academy, freeCodeCamp, Kaggle Learn, Coursera (preview and financial aid) and Virtual University NetAcad (unverified: registration closed). DigiSkills and AWS Educate stay in `eligibility.json`. Not yet confirmed, so not listed: NAVTTC e-learning (no terms on the portal), Khan Academy (certificates unconfirmed), Hugging Face courses (page does not say free) | Every record has a source and a date; anything unconfirmed starts `unverified` |
| **L3 API** ✅ built | filters `format`, `certificate`, `language`, `level`, `role`, `credential` (each a comma list, any of) and `free_certificate=true` (certificate is free; a free badge does not count). A record with no `learning` block, or with that field missing, never matches an active learning filter. Summaries of courses carry a compact `learning` object | Tests for each filter, for unknown values and for combinations with the eligibility filters |
| **L4 Pages** ✅ built | `/learn/` (three sections: free certificate, free with a badge or no certificate, free to learn but the certificate costs money), `/learn/certificates/` (free certificates only, then the paid ones with the price), `/learn/pakistan/` (made for Pakistan first), a "What you get" box on each course page, a course section on `/in/pakistan/`, JSON-LD (`Course` with `offers` at price 0, and `hasCourseInstance` with a start date for cohorts). `/learn/for/{group}/` is **not built**: every course today is open to the public, so a group page would copy `/learn/`. Build it when there are courses made for teachers or students | `npm test` build guards pass; thin pages stay `noindex` |
| **L5 Freshness** | watch phrases for batch and deadline text; courses in the Re-check list | One nightly run covering the new records |

### 11.2 Decisions (13 Nov 2026)

1. **Which providers go first?** Pakistan-relevant programs first, then the global programs students ask about most. Only programs confirmed on the provider's own pages are listed. Few Pakistani programs publish terms in a form we can read, so the Pakistan list is short for now (DigiSkills, Virtual University NetAcad). More are added as official pages are found.
2. **Does a free audit count as free?** Yes, shown as `certificate: paid_optional` with the price, never as a free certificate.
3. **Do we list courses with a paid certificate at all?** Yes, with the amber badge, because that is the common trap people need to see.

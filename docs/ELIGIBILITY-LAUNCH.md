# Eligibility launch (M6): checklist and post drafts

Written 12 Nov 2026. This is the last module of `docs/ELIGIBILITY-PRD.md`. The pages are live. This chapter is about getting them found, and keeping them true until the December deadline.

---

## Chapter 1. Before you tell anyone

Do these first, so that nobody lands on a half-working page.

1. **Neon is loaded.** After the last data change merged, run `npm run load-seed` in `db/` (see `docs/LIVE-SETUP.md`). Check: `https://api.freemeans.com/catalog?group=students&country=PK` should list the live student offers, and `?status=unverified` should show 3 (Cursor, Google for Startups, MoFEPT with Cisco).
2. **The API worker is current.** After any change under `services/api/`, run `npx wrangler deploy` there. The API is not deployed by Cloudflare's Git build.
3. **The daily rebuild works.** GitHub → Actions → **Daily rebuild** should show green runs. It needs the `CLOUDFLARE_DEPLOY_HOOK` secret.
4. **Open the four pages yourself** on your phone, since most readers are on phones:
   - `https://freemeans.com/free-for/students/pakistan/`
   - `https://freemeans.com/free-for/ending-soon/`
   - `https://freemeans.com/free-for/`
   - `https://freemeans.com/in/pakistan/`

---

## Chapter 2. Search Console and Bing (about 15 minutes)

Google does not use IndexNow. It reads `sitemap.xml`, and you can ask it to look at the key pages sooner.

1. **Search Console → Sitemaps.** `sitemap.xml` should say *Success*, and the number of discovered pages should have grown. If it still shows the old count, submit it again.
2. **Request indexing for the four pages above.** Search Console → paste the URL in the top bar → *URL inspection* → **Request indexing**. Do this once per page. It is not a way to speed up pages that are already indexed.
3. **Rich results check.** Open Google's Rich Results Test for `https://freemeans.com/resources/google.ai-plus-student/` and for `https://freemeans.com/free-for/students/pakistan/`. Both should show valid breadcrumbs. (The PRD's M4 "done when" asks for this.)
4. **Bing Webmaster Tools.** The sitemap is already submitted. IndexNow pings Bing when the site is rebuilt on a push.
5. **Look again after 3 to 7 days.** Search Console → *Pages* should show the new URLs as indexed. If `/free-for/students/pakistan/` is *Crawled, currently not indexed*, do not resubmit. Add real content (a short plain-English explanation of the three traps below) and wait.

Which pages are meant to be indexed: the hub, students, teachers, nonprofits (5 or more offers each), their `/pakistan/` versions, `/in/pakistan/`, Ending soon, Myths, and every live offer page. Institutions and startups pages are `noindex` until they have 5 offers.

---

## Chapter 3. Dates to watch

| Date | What happens | What you do |
| --- | --- | --- |
| 1 Dec 2026 | DigiSkills Batch-05 classes start | Nothing. If the batch changes, the `Batch-05` watch phrase fails and the source check opens a pull request |
| mid-Dec 2026 | Target for the Pakistan student page to be indexed and shared | Chapter 2 and Chapter 4 done |
| 31 Dec 2026 | Last day to redeem Google AI Plus (and AI Pro for US students) | The offer reads *ended* on 1 Jan, from the browser script and from the next daily rebuild |
| 8 Jan 2027 | First offers pass 60 days since their last check | They appear under *Re-check by hand* in the source check summary. Read each provider page again and update `last_verified` |

---

## Chapter 4. Post drafts

Keep it plain. Say what is free, who it is for, and what it costs later. Link to the page. Do not promise anything the provider's page does not say, and never suggest ways around a verification.

### 4.1 LinkedIn or dev.to post

**Title:** Free tools Pakistani students can get, and three ways they go wrong

Most "free for students" lists online are old. Some of the offers ended long ago, and some charge your card after a year.

I run a small site called Freemeans. For every offer it checks the provider's own page and shows the date it checked. Here is what I found for students in Pakistan.

**Free for students (no card requirement listed on their pages)**
- GitHub Student Developer Pack and the GitHub Copilot Student plan (GitHub checks your student status)
- Azure for Students: US$100 of credit for 12 months, renewable each year while you study. No credit card
- Notion Plus, Figma Education and Office 365 A1, with a school email
- AWS Educate: free training and badges. It no longer gives credits
- JetBrains IDEs and Autodesk software, for learning only

**Three ways it goes wrong**
1. **It charges you later.** Google AI Plus is free for 12 months for university students, but it needs a payment card and it bills you the standard monthly price when the year ends unless you cancel first. You must claim it by 31 December 2026. Set a reminder.
2. **It is for learning only.** JetBrains and Autodesk free licenses are not for paid or client work.
3. **It is not for individuals.** The HEC Digital Library works through your university. You cannot sign up alone.

Every offer on the page lists who qualifies, what proof you need, whether a card is needed, and when it ends:
https://freemeans.com/free-for/students/pakistan/

If an offer is wrong or out of date, tell me and I will fix it.

### 4.2 Short message for UAF students (WhatsApp or a class group)

> Free tools for students in Pakistan, with the traps marked (card needed, ends 31 Dec, learning only). Checked on the provider's own pages: https://freemeans.com/free-for/students/pakistan/

### 4.3 Before you post

- Open the page and make sure the offers you name are still listed. The post names offers that can end.
- If you post after 31 December, remove the Google AI Plus line.
- Reply to comments with the page link, not with claims you cannot source.

---

## Chapter 5. After launch

- **Corrections:** when someone reports a wrong offer, read the provider's page, fix the record in `data/catalog/eligibility.json`, set `last_verified`, and open a pull request. Never edit a number from a comment alone.
- **Still unverified** (hidden from live lists until someone confirms them on the provider's page): `cursor.pro-student`, `google.startups-cloud`, `mofept.cisco-netacad`.
- **Next scope:** free learning (courses, certificates), PRD Chapter 11, once the December traffic has been measured.

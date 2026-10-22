# KF Fact-Check Review Desk

A web page for text experts to review the AI translations that the KF pilot's fact-check flagged: 1,592 segments
of the Diamond Sūtra, Bodhicaryāvatāra and Ratnaguṇasaṃcayagāthā in English, Chinese (Traditional) and Hindi. Each
segment shows the Tibetan and Sanskrit, the AI drafts, what the checker flagged and why, and the aligned Tibetan
commentaries (with English machine translations for the Diamond Sūtra and Ratnaguṇasaṃcayagāthā).

Links: `https://webuddhist-tech.github.io/kf-review-desk/#/en` (or `#/zh`, `#/hi`). Every segment has its own link.

This repository holds only the review page. It contains AI translations, the Tibetan and Sanskrit sources, the
commentaries and the checker's notes; it contains no human translations. The project's other material is in a
private repository.

## How reviews reach the team

Reviewers must give their name before they can mark anything. Every mark is saved in their browser and sent
automatically to the team's Google Sheet (one row per reviewer per segment, updated when they change it). Each row
also records the reviewer's public IP address (looked up through api.ipify.org, since Apps Script cannot see it),
their browser and system (e.g. "Chrome 142 · macOS") and a random device id kept in that browser. The page tells
reviewers this. An IP address alone does not identify a person: people on the same office network share one, and
mobile addresses change; the name and device id are what tell reviewers apart. The
header shows "Saved to team sheet" or, if the connection drops, "Not sent yet, will retry". Unsent marks are kept and
sent the next time the page is open. "Export my review" downloads a personal CSV/JSON backup.

## Setting up the Google Sheet (once)

1. Create a Google Sheet. Open **Extensions → Apps Script**, replace the code with
   [`google-sheet/Code.gs`](google-sheet/Code.gs), and save.
2. **Deploy → New deployment → Select type: Web app.** Execute as: **Me**. Who has access: **Anyone**. Deploy, and
   allow the permissions Google asks for.
3. Copy the web app URL (ends in `/exec`) into [`site/config.js`](site/config.js) as `submitUrl`, commit and push.

The sheet gets two tabs: **Reviews** (the current marks, with a link back to each segment) and **Log** (every batch
received). The endpoint accepts posts from anyone who has the page; the script stores them as plain text only.

To change the script later, use **Deploy → Manage deployments → Edit → Version: New version** so the URL stays the
same.

## Updating the data

The data in `site/data/` is built in the private project (`dashboard/build/build_data.py`) and copied here.
Pushing to `main` redeploys the page through `.github/workflows/pages.yml`.

## Run locally

```bash
python3 -m http.server 8765 --directory site
```

Then open http://localhost:8765/#/en.

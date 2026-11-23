# What needs the owner

Only the things that cannot be done from the build session.

1. **Make the repository public** on GitHub (judges need to see it).
2. **Turn on GitHub Pages** for the codelab: Settings, Pages, Source: "GitHub Actions". The workflow in
   `.github/workflows/pages.yml` publishes `codelab/` on every push to `main`.
3. **Upload the video** `demo/video.mp4` to YouTube (public or unlisted), then put its URL in the line
   marked `VIDEO_URL` in `README.md` and `docs/devpost.md`.
4. **Submit on Devpost** (deadline Tue Dec 15 2026, 11:00 AM PT) using `docs/devpost.md`.

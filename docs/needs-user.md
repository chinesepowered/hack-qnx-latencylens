# What needs the owner

Only the things that cannot be done from the build session.

1. **Make the repository public** on GitHub (judges need to see it).
2. **Turn on GitHub Pages** for the codelab: Settings, Pages, Source: "GitHub Actions". Then run the
   "Codelab on GitHub Pages" workflow once (Actions tab, Run workflow); it is skipped while the repository
   is private and runs by itself on later pushes to `codelab/`. Expected URL:
   https://chinesepowered.github.io/hack-qnx-latencylens/
3. **Upload the video** `demo/video.mp4` (2:22, 1920x1080, H.264) to YouTube, public or unlisted, with
   `demo/thumb.png` as the thumbnail and, if you like, `demo/video.srt` as captions. Then replace
   `VIDEO_URL` in `docs/devpost.md` (two places) and the link target `demo/video.mp4` on the
   "Demo video" line near the top of `README.md` with the YouTube URL.
4. **Submit on Devpost** (deadline Tue Dec 15 2026, 11:00 AM PT) using `docs/devpost.md`: the codelab URL
   goes in its own field.

For reference: the QNX license used in the build session was deactivated at the end of the session
(`qnxsoftwarecenter_clt -deactivateAll`), so capturing new traces on another machine needs
`-activateAll` there first.

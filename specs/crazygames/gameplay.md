# CrazyGames — Gameplay Requirements

Source: https://docs.crazygames.com/requirements/gameplay
Inspired by Facebook Instant Games best practices. Repeat non-compliant submitters can be restricted.

## Basic (must-pass visual + functional QA)

- **Readable:** legible text/images at `devicePixelRatio:1`, responsive iframes (16:9) + mobile. Test sizes:
  - Desktop non-fullscreen: `907x510, 1216x684, 1077x606, 821x462`
  - Desktop fullscreen: `1366x768, 1920x1080, 1536x864, 1280x720`
  - Mobile `800x450`, Tablet `1080x607`
- **Physics:** consistent across 60/144/165Hz (use delta-time, not frame count).
- **Language:** English mandatory. Other translations must be high quality. Use SDK `systemInfo.locale`, fallback to English.
- **Controls:** intuitive per device. See restricted keys in `quality-guidelines.md` (avoid `Esc` = exits fullscreen, `Ctrl/Cmd+W` = closes tab; prefer layout-agnostic bindings, e.g. `ZQSD` on AZERTY).
- **Performance:** fast load, no errors/crashes.
- **Originality:** original names, assets, content. `Super Chess` OK, `Chess` too generic, `Scrabble` only if you own IP.
- **Fullscreen:** DO NOT add custom fullscreen button. CrazyGames injects it; custom breaks monetization/features.
- **Cross-promo bans:**
  - No external/internal game/platform promos.
  - Allowed (not as main menu CTA): Discord/dev-site (must not lead to playable web version), game-store links (Epic/Steam, desktop only, menu or end-of-demo), backlink to CG home/category, links to same series (e.g. Horror Tale 1/2/3).
  - App Store links never in-game — use portal metadata fields.
  - Exception: Privacy Policy / Terms links (see technical spec).
- **Minors:** 13+ audience, **PEGI-12** compliant. `kids.crazygames.com` exists but monetization disabled there.

## Full (additional)

- Land new users **directly in gameplay**. If impossible, max **1 click**.
- Full visual QA is stricter.

## Quality guidelines (recommended, not mandatory)

See `quality-guidelines.md` for onboarding/fun/uniqueness/polish. Implement: in-gameplay skippable onboarding, visual > text, keyboard overlay, clear buttons (no delays, no ad-bait sizing).

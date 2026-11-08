# packages/brand

The Freemeans design system in code form, a copy of the Freemeans Design System artifact.

- `tokens.json`: colours (light and dark), type families and sizes, spacing, radii.
- `logos/freemeans-mark.svg`: the "F." mark (an F of stack bars plus a full stop).
- `logos/freemeans-lockup.svg`: the mark plus the "freemeans" wordmark.

Both logos use `currentColor`. `apps/web/scripts/build-tokens.mjs` generates the site's CSS variables from `tokens.json`. Change a colour here and the site follows on its next build.

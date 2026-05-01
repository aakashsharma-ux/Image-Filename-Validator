# Image Filename Validator

A lightweight, browser-based tool that validates image filenames against a strict `mmm_dd_yyyy` naming convention. No backend, no frameworks — just HTML, CSS, and vanilla JavaScript.

---

## Live Demo

Open `index.html` directly in any modern browser. No server required.

---

## Naming Convention

| Part  | Rule                            | Example  |
|-------|---------------------------------|----------|
| Month | Exactly 3 **lowercase** letters | `apr`    |
| Day   | Always **2 digits** (zero-pad)  | `01`     |
| Year  | Always **4 digits**             | `2024`   |

Full format: `mmm_dd_yyyy` → e.g. **`apr_01_2024.jpg`**

### Valid examples

```
apr_01_2024.jpg    ✅
jan_15_2023.png    ✅
dec_31_2025.webp   ✅
```

### Invalid examples

| Filename              | Reason                          |
|-----------------------|---------------------------------|
| `april_01_2024.jpg`   | Full month name — use 3 letters |
| `Apr_01_2024.jpg`     | Uppercase letters not allowed   |
| `apr_1_2024.jpg`      | Day must be 2 digits (use `01`) |
| `APR_1_24.jpg`        | Uppercase + short year + 1-digit day |
| `apr_32_2024.jpg`     | Day out of range (01–31)        |

---

## Features

- **Drag & drop** or **browse** to upload multiple image files
- **Instant validation** with specific failure reasons for each file
- **Color-coded results** — green for valid, red for invalid
- **Stats panel** — total / valid / invalid counts
- **Filter** — view all, valid-only, or invalid-only
- **CSV export** — download a full report of all validated files
- **Dark mode** support via CSS media query
- **Accessible** — keyboard navigation and ARIA attributes
- **Zero dependencies** — no npm, no build step

---

## Project Structure

```
image-filename-validator/
├── index.html      # Markup & layout
├── style.css       # All styles (light + dark mode)
├── validator.js    # Pure validation logic (no DOM)
├── app.js          # UI wiring, events, CSV export
└── README.md       # This file
```

---

## Getting Started

### Option 1 — Open directly

```bash
# Clone the repo
git clone https://github.com/your-username/image-filename-validator.git

# Open in browser
open image-filename-validator/index.html
```

### Option 2 — Serve locally (optional, for live-reload dev)

```bash
# Python 3
cd image-filename-validator
python3 -m http.server 8080
# then visit http://localhost:8080
```

---

## How Validation Works

Validation runs entirely in `validator.js` and follows these ordered checks:

1. Strip the file extension (`apr_01_2024.jpg` → `apr_01_2024`)
2. Reject if any uppercase letters are present
3. Reject if no underscores exist
4. Reject if there aren't exactly 3 underscore-separated parts
5. Reject if the month part isn't exactly 3 lowercase letters
6. Reject if the month isn't a real calendar abbreviation (`jan`–`dec`)
7. Reject if the day part isn't exactly 2 digits
8. Reject if the day is out of range (01–31)
9. Reject if the year part isn't exactly 4 digits
10. Final regex guard: `/^([a-z]{3})_(\d{2})_(\d{4})$/`

Each failure returns a specific human-readable reason displayed in the table.

---

## Browser Support

Works in all modern browsers (Chrome, Firefox, Safari, Edge). No polyfills needed.

---

## License

MIT — free to use, modify, and distribute.

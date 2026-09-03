import React from "react";

/**
 * BrandMark — JK Products official logo.
 *
 * The source artwork is a black-on-transparent PNG (uploaded by the client).
 *   - `variant="dark"` (on dark navy sidebars / topbars) → invert to white so
 *      the mark stays visible.
 *   - `variant="light"` (on white / light surfaces) → render as-is (black).
 *   - `variant="brand"` (rare, e.g. invoice headers) → tint to brand orange.
 *
 * Props:
 *   size      → square px box (default 40). Image is letterboxed inside.
 *   variant   → "dark" | "light" | "brand"
 *   className → extra wrapper classes
 */
const LOGO_URL = "/logo-original.png";

const FILTERS = {
  // Pure white (perfect for dark sidebars)
  dark: "brightness(0) invert(1)",
  // Source artwork is already black on transparent — keep as-is
  light: "none",
  // Orange tint (#E65100): black-source → orange via single-step matrix.
  // Trick: brightness(0) zeroes the image, sepia gives orange-brown base,
  // then saturate + hue-rotate dials it to brand orange.
  brand:
    "brightness(0) saturate(100%) invert(35%) sepia(96%) saturate(2300%) hue-rotate(7deg) brightness(95%) contrast(105%)",
};

export default function BrandMark({ size = 40, variant = "dark", className = "" }) {
  const filter = FILTERS[variant] || FILTERS.dark;
  return (
    <span
      className={`inline-block shrink-0 ${className}`}
      style={{ width: size, height: size }}
      data-testid="brand-mark"
      aria-label="JK Products"
    >
      <img
        src={LOGO_URL}
        alt="JK Products"
        width={size}
        height={size}
        draggable={false}
        style={{
          width: size,
          height: size,
          objectFit: "contain",
          filter,
          display: "block",
        }}
      />
    </span>
  );
}

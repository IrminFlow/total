import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Total accounting",
    short_name: "Total",
    description: "Offline-first accounting for Indian businesses.",
    start_url: "/",
    scope: "/",
    display: "browser",
    background_color: "#f4f4ef",
    theme_color: "#0e1220",
    icons: [{ src: "/icon.png", sizes: "512x512", type: "image/png" }],
  };
}

/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      colors: {
        ink: {
          950: "#0E1220",
          900: "#141A2E",
          800: "#1B2340",
          700: "#26304F",
          600: "#374267"
        },
        signal: {
          amber: "#F0A93B",
          orange: "#FF7A29",
          teal: "#1F9D77",
          red: "#E5484D",
          blue: "#3E6AE1"
        },
        paper: "#F6F7FA"
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
        mono: ["'JetBrains Mono'", "ui-monospace", "SFMono-Regular", "monospace"]
      },
      boxShadow: {
        panel: "0 1px 2px rgba(14, 18, 32, 0.06), 0 1px 12px rgba(14, 18, 32, 0.04)"
      }
    }
  },
  plugins: []
};

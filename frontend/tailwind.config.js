import typography from "@tailwindcss/typography";

/** @type {import('tailwindcss').Config} */
export default {
  content: ["./app/**/*.{js,ts,jsx,tsx}", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      typography: {
        DEFAULT: {
          css: {
            'code::before': { content: 'none' },
            'code::after': { content: 'none' },
            code: {
              color: 'inherit',
              fontWeight: '400',
            },
            pre: {
              backgroundColor: '#111827',
              color: '#f3f4f6',
            },
            'pre code': {
              color: 'inherit',
              fontSize: 'inherit',
              fontWeight: 'inherit',
              fontFamily: 'inherit',
            },
          },
        },
      },
      fontFamily: {
        sans: [
          "DM Sans",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "sans-serif",
        ],
        mono: ["IBM Plex Mono", "SF Mono", "Monaco", "monospace"],
      },
      colors: {
        surface: {
          DEFAULT: "#ffffff",
          secondary: "#f9fafb",
          tertiary: "#f3f4f6",
        },
        layer: {
          1: "#fafbfc",
          2: "#f6f7f9",
          3: "#f1f3f5",
        },
        accent: {
          50: "#eef4fb",
          100: "#d6e4f3",
          200: "#b5cde5",
          300: "#8bb2d4",
          400: "#6594c0",
          500: "#3f72af",
          600: "#345f94",
          700: "#2a4e7a",
        },
      },
      boxShadow: {
        subtle: "0 1px 2px 0 rgb(0 0 0 / 0.05)",
        card: "0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)",
        elevated:
          "0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)",
      },
      borderRadius: {
        DEFAULT: "0.375rem",
        sm: "0.25rem",
        md: "0.375rem",
        lg: "0.5rem",
        xl: "0.75rem",
      },
    },
  },
  plugins: [typography],
};

// Side-effect CSS imports (handled by Vite at build time) have no type
// declarations of their own; declare them so the client type-checks cleanly.
declare module '*.css';

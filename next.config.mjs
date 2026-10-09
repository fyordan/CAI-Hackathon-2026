/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  // the reset route reads sql/schema.sql at runtime; make sure Vercel bundles it
  outputFileTracingIncludes: { "/api/demo/reset": ["./sql/**"] },
};

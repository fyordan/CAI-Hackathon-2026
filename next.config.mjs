/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  // the floating dev badge sits on top of the mic button during live demos
  devIndicators: false,
  // the reset route reads sql/schema.sql at runtime; make sure Vercel bundles it
  outputFileTracingIncludes: { "/api/demo/reset": ["./sql/**"] },
};

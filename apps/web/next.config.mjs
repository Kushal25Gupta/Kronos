/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@kronos/core", "@kronos/retrieval", "@kronos/audio"],

  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          // Cross-origin isolation, required for SharedArrayBuffer — which the
          // audio ring buffer uses to hand PCM between the worklet and the main
          // thread without copying.
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              // 'wasm-unsafe-eval' is required to instantiate the ONNX runtime's
              // WebAssembly module. 'unsafe-eval' is deliberately NOT granted.
              "script-src 'self' 'wasm-unsafe-eval' 'unsafe-inline'",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data: blob:",
              // THE LOAD-BEARING LINE. 'self' only: no third-party origin can be
              // contacted, so deal-document content cannot leave the machine even
              // if some dependency tried. Notably this also blocks huggingface.co,
              // which is why model weights must be vendored locally by
              // scripts/fetch-models.mjs rather than fetched from the hub.
              "connect-src 'self'",
              // blob: is needed for the inlined AudioWorklet processor.
              "worker-src 'self' blob:",
            ].join("; "),
          },
        ],
      },
    ];
  },

  // Next compiles client components during the server (SSR/RSC) pass as well, so
  // these must be kept out of BOTH bundles. Leaving them as runtime requires
  // means Node resolves the correct native binary itself.
  experimental: {
    serverComponentsExternalPackages: [
      "@xenova/transformers",
      "onnxruntime-node",
      "sharp",
    ],
  },

  webpack(config, { isServer, webpack }) {
    // Workspace packages are authored as ESM TypeScript with .js specifiers.
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js", ".jsx"],
    };

    if (!isServer) {
      // transformers.js imports both onnxruntime-node and onnxruntime-web and
      // picks at runtime. Webpack follows both branches statically, and the node
      // build ships prebuilt .node binaries that cannot be parsed for the
      // browser. Stub the Node backend out of the client bundle; the browser
      // legitimately only needs onnxruntime-web.
      config.resolve.alias = {
        ...config.resolve.alias,
        "onnxruntime-node": false,
        // sharp is transformers.js' Node-side image decoder. KRONOS processes
        // text and audio only, and sharp is native code regardless.
        sharp: false,
      };

      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        path: false,
        crypto: false,
      };
    } else {
      // Keep the native module as a runtime require on the server.
      config.externals = [
        ...(Array.isArray(config.externals) ? config.externals : [config.externals].filter(Boolean)),
        { "onnxruntime-node": "commonjs onnxruntime-node", sharp: "commonjs sharp" },
      ];
    }

    // onnxruntime-node resolves its platform binary through a dynamic require
    // over a directory of prebuilt .node files. Webpack expands that context
    // eagerly and chokes on binaries for other platforms (win32/arm64 etc.).
    // Nothing should ever bundle these.
    config.plugins.push(
      new webpack.IgnorePlugin({
        resourceRegExp: /\.node$/,
        contextRegExp: /onnxruntime-node/,
      })
    );

    return config;
  },
};


export default nextConfig;

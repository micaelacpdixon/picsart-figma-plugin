const InlineChunkHtmlPlugin = require("react-dev-utils/InlineChunkHtmlPlugin");
const HtmlWebpackPlugin = require("html-webpack-plugin");

const path = require("path");
const webpack = require("webpack");

// Figma evaluates dist/code.js inside an SES realm, which refuses any source
// that might contain a dynamic import. Its guard is a regex, not a parser:
// the word `import` followed by whitespace and then `(`, `//` or `/*`. A prose
// comment ending in the word "import" whose next line starts with `//` matches
// it, and Figma then fails the plugin with
//
//   SyntaxError: possible import expression rejected around line 1
//
// before running a line of it. Production builds strip comments, so this only
// bites the development bundle — the one `npm run watch` feeds to Figma — and
// neither typecheck, lint nor test:run can see it. Hence a build-time check.
const SES_IMPORT_EXPRESSION = /(?:^|[^.$\w])\bimport(?:\s*(?:\(|\/[/*]))/;

class RejectImportExpressionPlugin {
  // Only the sandbox bundle matters: the UI is a normal iframe, not a realm.
  constructor(assetName) {
    this.assetName = assetName;
  }

  apply(compiler) {
    compiler.hooks.compilation.tap("RejectImportExpression", (compilation) => {
      compilation.hooks.processAssets.tap(
        {
          name: "RejectImportExpression",
          stage: compiler.webpack.Compilation.PROCESS_ASSETS_STAGE_REPORT,
        },
        (assets) => {
          const asset = assets[this.assetName];
          if (!asset) return;

          const source = asset.source().toString();
          const index = source.search(SES_IMPORT_EXPRESSION);
          if (index === -1) return;

          const line = source.slice(0, index).split("\n").length;
          const excerpt = source.slice(index, index + 80).replace(/\n/g, "\\n");
          compilation.errors.push(
            new webpack.WebpackError(
              `${this.assetName} line ${line} reads as a dynamic import to Figma's ` +
                `SES realm, which will reject the whole plugin at load time:\n` +
                `  ${excerpt}\n` +
                `Reword it so \`import\` is not followed by whitespace and then ` +
                `\`(\`, \`//\` or \`/*\` — a comment line ending in the word ` +
                `"import" is the usual cause.`,
            ),
          );
        },
      );
    });
  }
}

module.exports = (env, argv) => ({
  mode: argv.mode === "production" ? "production" : "development",
  devtool: argv.mode === "production" ? false : "inline-source-map",
  entry: {
    ui: "./src/ui.tsx",
    code: "./src/code.ts",
  },
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        use: "ts-loader",
        exclude: /node_modules/,
      },
      {
        test: /\.css$/,
        oneOf: [
          {
            test: /@picsart[\\/]design-system[\\/]foundation\.css$/,
            use: ["style-loader", "css-loader", path.resolve(__dirname, "scripts/cascade-foundation-loader.mjs")],
          },
          { use: ["style-loader", "css-loader"] },
        ],
      },
      {
        test: /\.svg/,
        type: "asset/inline",
      },
      { test: /\.(woff|woff2|eot|ttf|otf|png)$/, type: "asset/inline" },
      {
        test: /\.s[ac]ss$/i,
        use: [
          "style-loader", 
          {
            loader: "css-loader", 
            options: {
              url: true, 
              sourceMap: argv.mode !== "production",
            },
          },
          {
            loader: "sass-loader",
            options: {
              // The legacy JS API is deprecated and goes away in Dart Sass 2.0.
              // Every .scss import warned about it on every build until this was
              // set, which is 14 of the build's warnings.
              api: "modern-compiler",
              sourceMap: argv.mode !== "production",
            },
          },
        ],
      },
    ],
  },
  resolve: { extensions: [".tsx", ".ts", ".jsx", ".js", ".scss"],
    alias : {
      "@assets": path.resolve(__dirname, 'assets'),
      "@routes": path.resolve(__dirname, 'routes'),
      "@controllers": path.resolve(__dirname, 'controllers'),
      "@services": path.resolve(__dirname, 'services'),
      "@constants": path.resolve(__dirname, 'constants/'),
      "@ui_constants": path.resolve(__dirname, 'src/ui_constants/'),
      "@styles": path.resolve(__dirname, 'src/styles/'),
      "@utils": path.resolve(__dirname, 'src/utils/'),
      "@hooks": path.resolve(__dirname, 'src/hooks/'),
      "@components": path.resolve(__dirname, 'src/components/'),
      "@api": path.resolve(__dirname, 'src/api/'),
      "@ui": path.resolve(__dirname, 'src/components/ui/'),
      // Renamed from "@types". That name shadows the DefinitelyTyped scope, so
      // `@types/react` in a source file was ambiguous between the package and this
      // directory — latent rather than live, but the alias had zero references and was
      // free to rename before it bit.
      "@app-types": path.resolve(__dirname, 'src/types/'),
    }
  },
  output: {
    filename: "[name].js",
    clean: true,
    path: path.join(__dirname, env.agentsBeta ? "dist-beta" : "dist"),
    publicPath: '/',
  },
  // webpack's 244 KiB default is a network-delivery budget, and nothing here is
  // delivered over a network: InlineChunkHtmlPlugin inlines the UI chunk into
  // ui.html and Figma loads that file from local disk. The check is kept rather
  // than switched off because CLAUDE.md treats a build warning as a real finding,
  // and that only holds while the build is otherwise warning-free — so the limit
  // allows the four bundled Gilroy weights and two agent portraits. An
  // accidental dependency or additional unbounded portrait set still trips it.
  performance: {
    maxAssetSize: (env.agentsBeta ? 1280 : 600) * 1024,
    maxEntrypointSize: (env.agentsBeta ? 1280 : 600) * 1024,
  },
  plugins: [
    new webpack.DefinePlugin({
      global: {},
      __AGENTS_BETA__: JSON.stringify(Boolean(env.agentsBeta)),
    }),
    new HtmlWebpackPlugin({
      inject: "body",
      template: "./public/index.html",
      filename: "ui.html",
      chunks: ["ui"],
    }),
    new InlineChunkHtmlPlugin(HtmlWebpackPlugin, [/ui/]),
    new RejectImportExpressionPlugin("code.js"),
  ],

});

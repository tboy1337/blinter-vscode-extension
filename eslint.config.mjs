import globals from "globals";

export default [
{
    ignores: [
        "node_modules/**",
        ".vscode-test/**",
        ".vscode/**",
        "out/**",
        "releases/**",
        "vendor/**",
        "coverage/**",
        "**/*.vsix"
    ]
},
{
    files: [
        "extension.js",
        "lib/**/*.js",
        "test/**/*.js",
        "tools/**/*.js"
    ],
    languageOptions: {
        globals: {
            ...globals.commonjs,
            ...globals.node,
            ...globals.mocha,
        },

        ecmaVersion: 2022,
        sourceType: "commonjs",
    },

    rules: {
        "no-const-assign": "error",
        "no-this-before-super": "error",
        "no-undef": "error",
        "no-unreachable": "error",
        "no-unused-vars": ["error", { "argsIgnorePattern": "^_", "caughtErrorsIgnorePattern": "^_" }],
        "constructor-super": "error",
        "valid-typeof": "error",
        "eqeqeq": ["error", "always", { "null": "ignore" }],
        "curly": ["error", "all"],
        "no-var": "error",
        "prefer-const": "error",
        "no-throw-literal": "error",
        "no-useless-return": "error",
        "no-duplicate-imports": "error",
        "no-shadow": "error",
        "prefer-template": "error",
    },
}
];

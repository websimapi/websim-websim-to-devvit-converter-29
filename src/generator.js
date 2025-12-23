import JSZip from 'jszip';
import { 
    cleanName, 
    AssetAnalyzer 
} from './processors.js';

import {
    generatePackageJson,
    generateDevvitJson,
    generateClientViteConfig,
    generateServerViteConfig,
    tsConfig,
    getMainTs,
    simpleLoggerJs,
    websimSocketPolyfill,
    websimStubsJs,
    websimPackageJs,
    jsxDevProxy,
    validateScript,
    setupScript,
    generateReadme
} from './templates.js';

export async function generateDevvitZip(projectMeta, assets, includeReadme = true) {
    const zip = new JSZip();
    
    const safeId = projectMeta.project.id ? projectMeta.project.id.slice(0, 4) : '0000';
    const rawSlug = cleanName(projectMeta.project.slug || "websim-game");
    const truncatedSlug = rawSlug.slice(0, 11);
    const projectSlug = `${truncatedSlug}-${safeId}`;
    const projectTitle = projectMeta.project.title || "WebSim Game";

    // Initialize Analyzer
    const analyzer = new AssetAnalyzer();
    const clientFiles = {};

    // 1. Process Assets
    for (const [path, content] of Object.entries(assets)) {
        if (path.includes('..')) continue;

        if (/\.(js|mjs|ts|jsx|tsx)$/i.test(path)) {
            const processed = analyzer.processJS(content, path);
            clientFiles[path] = processed;
        } else if (path.endsWith('.html')) {
            const { html, extractedScripts } = analyzer.processHTML(content, path.split('/').pop());
            clientFiles[path] = html;
            
            extractedScripts.forEach(script => {
                const parts = path.split('/');
                parts.pop();
                const dir = parts.join('/');
                const fullPath = dir ? `${dir}/${script.filename}` : script.filename;
                clientFiles[fullPath] = script.content;
            });
        } else if (path.endsWith('.css')) {
            clientFiles[path] = analyzer.processCSS(content, path);
        } else {
            clientFiles[path] = content;
        }
    }

    // 2. Configs
    const hasRemotion = !!analyzer.dependencies['remotion'];
    let hasReact = hasRemotion || !!analyzer.dependencies['react'];
    const hasTailwind = analyzer.hasTailwind;

    // Final check for React if not caught by dependency analysis (handles inline scripts)
    if (!hasReact) {
        for (const content of Object.values(clientFiles)) {
            const code = (content instanceof Uint8Array) ? new TextDecoder().decode(content) : String(content);
            if (/<[A-Z][A-Za-z0-9]*[\s>]/g.test(code) || /className=/g.test(code)) {
                hasReact = true;
                break;
            }
        }
    }

    const extraDevDeps = {};
    if (hasReact) {
        extraDevDeps['@vitejs/plugin-react'] = '^4.2.0';
        extraDevDeps['@babel/core'] = '^7.23.0';
        extraDevDeps['@babel/preset-react'] = '^7.23.0';
    }

    if (hasTailwind) {
        extraDevDeps['tailwindcss'] = '^3.4.0';
        extraDevDeps['postcss'] = '^8.4.0';
        extraDevDeps['autoprefixer'] = '^10.4.0';
        
        // Place config files in src/client so Vite/PostCSS can find them during build:client
        zip.file("src/client/tailwind.config.js", `
/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html", 
    "./*.{js,ts,jsx,tsx}", 
    "./**/*.{js,ts,jsx,tsx}"
  ],
  theme: { extend: {} },
  plugins: [],
}`.trim());
        
        zip.file("src/client/postcss.config.js", `
export default {
  plugins: { tailwindcss: {}, autoprefixer: {} },
}`.trim());

        // Prepend tailwind directives to the first found CSS file
        let cssFound = false;
        for (const path of Object.keys(clientFiles)) {
            if (path.endsWith('.css')) {
                clientFiles[path] = `@tailwind base;\n@tailwind components;\n@tailwind utilities;\n\n` + clientFiles[path];
                cssFound = true;
                break;
            }
        }

        // If no CSS file exists, create one and inject it to ensure Tailwind base styles load
        if (!cssFound) {
            const cssPath = 'tailwind_generated.css';
            clientFiles[cssPath] = `@tailwind base;\n@tailwind components;\n@tailwind utilities;\n`;
            
            // Find index.html to inject the link
            const indexPath = Object.keys(clientFiles).find(p => p.endsWith('index.html'));
            if (indexPath) {
                let htmlContent = clientFiles[indexPath];
                if (htmlContent instanceof Uint8Array) {
                    htmlContent = new TextDecoder().decode(htmlContent);
                }
                
                // Only inject if not already present
                if (!htmlContent.includes(cssPath)) {
                    // Try to inject before </head>, fallback to body
                    if (htmlContent.includes('</head>')) {
                        htmlContent = htmlContent.replace('</head>', `<link rel="stylesheet" href="./${cssPath}">\n</head>`);
                    } else {
                        htmlContent = `<link rel="stylesheet" href="./${cssPath}">\n` + htmlContent;
                    }
                    clientFiles[indexPath] = htmlContent;
                }
            }
        }
    }

    zip.file("package.json", generatePackageJson(projectSlug, analyzer.dependencies, extraDevDeps));
    zip.file("devvit.json", generateDevvitJson(projectSlug));
    zip.file("tsconfig.json", tsConfig);
    zip.file(".gitignore", "node_modules\n.devvit\ndist"); 

    if (includeReadme) {
        zip.file("README.md", generateReadme(projectTitle, `https://websim.ai/p/${projectMeta.project.id}`));
    }

    zip.file("scripts/setup.js", setupScript);
    zip.file("scripts/validate.js", validateScript);

    // 3. Client Folder (src/client)
    const srcFolder = zip.folder("src");
    const clientFolder = srcFolder.folder("client");
    
    clientFolder.file("vite.config.ts", generateClientViteConfig({ hasReact, hasRemotion }));

    for (const [path, content] of Object.entries(clientFiles)) {
        clientFolder.file(path, content);
    }

    // Polyfills in src/client
    
    // Generate Global Shims for CDN packages
    let shimCode = '';
    if (analyzer.globalShims.size > 0) {
        shimCode += '// Global Shims for CDN libraries\n';
        if (analyzer.globalShims.has('react')) shimCode += "import React from 'react'; window.React = React;\n";
        if (analyzer.globalShims.has('react-dom')) shimCode += "import ReactDOM from 'react-dom'; window.ReactDOM = ReactDOM;\n";
        if (analyzer.globalShims.has('three')) shimCode += "import * as THREE from 'three'; window.THREE = THREE;\n";
        if (analyzer.globalShims.has('jquery')) shimCode += "import $ from 'jquery'; window.$ = window.jQuery = $;\n";
        if (analyzer.globalShims.has('pixi.js')) shimCode += "import * as PIXI from 'pixi.js'; window.PIXI = PIXI;\n";
        if (analyzer.globalShims.has('p5')) shimCode += "import p5 from 'p5'; window.p5 = p5;\n";
        shimCode += '\n';
    }

    const combinedPolyfills = [shimCode, simpleLoggerJs, websimSocketPolyfill, websimStubsJs].join('\n\n');
    clientFolder.file("websim_polyfills.js", combinedPolyfills);
    clientFolder.file("websim_package.js", websimPackageJs);
    clientFolder.file("jsx-dev-proxy.js", jsxDevProxy);

    if (hasRemotion) {
        clientFolder.file("remotion_bridge.js", `
export * from 'remotion';
export { Player } from '@remotion/player';
        `.trim());
    }

    // 4. Server Folder (src/server)
    const serverFolder = srcFolder.folder("server");
    serverFolder.file("index.ts", getMainTs(projectTitle));
    serverFolder.file("vite.config.ts", generateServerViteConfig());
    
    const blob = await zip.generateAsync({ type: "blob" });
    return { blob, filename: `${projectSlug}-devvit.zip` };
}


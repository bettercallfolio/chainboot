# chainboot website

Static pages with no dependencies and no outside requests: the landing page (`index.html`,
`style.css`, `app.js`, `favicon.svg`) and the documentation in `docs/`.

The documentation pages are generated from the Markdown guides in the repository's `docs/`
folder. After changing a guide, run `npm run site` and commit the result (CI checks this). Open `index.html` in a browser, or serve this folder with
any web server:

```sh
npx serve site        # or: python3 -m http.server -d site 8080
```

It can be hosted as it is on GitHub Pages, Vercel, Netlify, Cloudflare Pages or any file server.

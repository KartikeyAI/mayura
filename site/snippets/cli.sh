npx mayura init          # pick a starter and a model provider
cd my-agent && npm install
npm run dev              # mayura dev: build, run, restart on save

mayura migrate --app dist/src/app.js
mayura serve --app dist/src/app.js
mayura worker --app dist/src/app.js

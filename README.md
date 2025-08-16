# 💧 CtroDB: The Reactive JavaScript Database

[![NPM Version](https://img.shields.io/npm/v/ctrodb.svg)](https://www.npmjs.com/package/ctrodb)
[![License: MIT](https://img.shields.io/npm/l/ctrodb.svg)](https://opensource.org/licenses/MIT)
[![Build Status](https://img.shields.io/github/actions/workflow/status/ctrotech-tutor/ctrodb/main.yml?branch=main)](https://github.com/ctrotech-tutor/ctrodb/actions)
[![Minified Size](https://img.shields.io/bundlephobia/min/ctrodb.svg)](https://bundlephobia.com/result?p=ctrodb)

**CtroDB is a modern, high-performance, and reactive client-side database from Ctrotech. Built with zero dependencies and based on Ctrotech Tutor insights, it provides a structured, relational-like API on top of the browser's native IndexedDB, giving you the best of both worlds: performance and developer experience.**

Stop fighting with `localStorage` and `IndexedDB`'s raw API. CtroDB makes it easy to build complex, data-driven applications that feel incredibly fast and responsive.

---

## Table of Contents

- [Why CtroDB?](#why-ctrodb)
- [Key Features](#-key-features)
- [Environments](#-environments)
- [Installation & Usage](#-installation--usage)
  - [1. Using with NPM (Recommended)](#1-using-with-npm-recommended)
  - [2. Using in the Browser with `<script>`](#2-using-in-the-browser-with-script)
- [Core Concepts](#-core-concepts)
  - [The Schema](#the-schema)
  - [The Database](#the-database)
  - [Collections & Models](#collections--models)
  - [Queries](#queries)
  - [Reactivity with `observe()`](#reactivity-with-observe)
- [Advanced Usage](#-advanced-usage)
  - [Relational Queries](#relational-queries)
  - [Complex `OR` Queries](#complex-or-queries)
  - [Debugging](#debugging)
- [Contributing](#-contributing)
- [License](#️-license)

---

## Why CtroDB?

| Problem with Traditional Tools | How CtroDB Solves It |
| :--- | :--- |
| **`localStorage` is slow & blocking.** | CtroDB is fully asynchronous and non-blocking, ensuring a smooth UI. |
| **`IndexedDB` API is complex & verbose.** | CtroDB provides a clean, modern, and chainable API that is a joy to use. |
| **Managing data relationships is hard.** | CtroDB has built-in support for `has_many` and `belongs_to` relations. |
| **Keeping UI in sync with data is messy.** | The `.observe()` method provides effortless, fine-grained reactivity out of the box. |
| **No clear structure or schema.** | CtroDB is schema-driven, ensuring data consistency and enabling migrations. |

## ✨ Key Features

*   **🚀 Super Fast:** Built to be highly performant, using indexed queries and key ranges to retrieve data in milliseconds.
*   **💧 Reactive and Live:** Use `.observe()` on any query to get live updates in your UI.
*   **🔗 Model Relations:** Define `has_many` and `belongs_to` relationships between your data collections.
*   **🛠️ Clean, Modern API:** A fluent, intuitive API with expressive queries like `.where('field', '>', value)` and `.orWhere(...)`.
*   **📦 Multi-Environment Support:** Works seamlessly in Node.js, with modern bundlers (Vite, Webpack), and directly in the browser via a `<script>` tag.
*   **🪶 Zero Dependencies:** Written in plain, modern JavaScript, making it lightweight, transparent, and secure.
*   **🐛 Built-in Debugging:** A configurable, level-based logger to help you diagnose issues and understand data flow.

## 🌍 Environments

CtroDB is built to be universal and works in any modern JavaScript environment.

| Environment | Support | How to Use |
| :--- | :--- | :--- |
| **Modern Bundlers** (Vite, Webpack) | ✅ **Yes** | `import { Database } from 'ctrodb';` |
| **Node.js** | ✅ **Yes** | `const { Database } = require('ctrodb');` |
| **Browser `<script>` Tag** | ✅ **Yes** | `<script src=".../ctrodb.umd.js"></script>` |

## 📦 Installation & Usage

### 1. Using with NPM (Recommended)

Install the package using your favorite package manager:

```bash
npm install ctrodb
```

Then, import it into your project:

```javascript
import { Database, Schema, LogLevel } from 'ctrodb';

// 1. Define your schema
const mySchema = new Schema({
  version: 1,
  collections: {
    posts: {
      fields: { title: 'string', rating: 'number' },
      indexes: ['rating'],
    },
  },
});

// 2. Initialize and connect to the database
const db = new Database({
  schema: mySchema,
  dbName: 'MyWebAppDB',
  logLevel: LogLevel.INFO,
});
await db.connect();

// 3. Query your data
const topPosts = await db.getCollection('posts').query()
  .where('rating', '>=', 5)
  .fetch();
```

### 2. Using in the Browser with `<script>`

For simple projects, prototypes, or environments without a build step, you can use the UMD (Universal Module Definition) build.

1.  Download the latest `ctrodb.umd.js` file from the [Releases page](https://github.com/ctrotech-tutor/ctrodb/releases) on GitHub or from a CDN like [unpkg](https://unpkg.com/ctrodb/dist/ctrodb.umd.js).
2.  Include it in your HTML file.

```html
<!DOCTYPE html>
<html>
<head>
  <title>CtroDB UMD Example</title>
</head>
<body>
  <h1>My App</h1>

  <!-- Load the CtroDB library -->
  <script src="https://unpkg.com/ctrodb/dist/ctrodb.umd.js"></script>

  <script>
    // CtroDB is now available as a global variable!
    const { Database, Schema } = window.CtroDB;

    const mySchema = new Schema({
      version: 1,
      collections: { users: { fields: { name: 'string' } } }
    });

    const db = new Database({ schema: mySchema, dbName: 'BrowserDB' });

    async function runApp() {
      await db.connect();
      const users = db.getCollection('users');
      await users.create({ name: 'Alice' });
      const allUsers = await users.query().fetch();
      console.log(allUsers);
    }

    runApp();
  </script>
</body>
</html>
```

## 🧠 Core Concepts

(This section remains the same, detailing Schema, Database, Collections, Queries, and Reactivity.)

### The Schema
The `Schema` is the blueprint for your database...

### The Database
The `Database` class is the main entry point to CtroDB...

### Collections & Models
You interact with your data through `Collection` objects...

### Queries
The `Query` builder provides a clean, chainable API...

### Reactivity with `observe()`
This is the magic of CtroDB...

## 💡 Advanced Usage

(This section remains the same, detailing Relations, OR Queries, and Debugging.)

### Relational Queries
Define relations in your schema...

### Complex `OR` Queries
Use the `.orWhere()` method to build complex, compound queries...

### Debugging
CtroDB has a built-in logger...

## 🤝 Contributing

Contributions, issues, and feature requests are welcome! Feel free to check the [issues page](https://github.com/ctrotech-tutor/ctrodb/issues). Please read the `CONTRIBUTING.md` file for details on our code of conduct and the process for submitting pull requests.

## ⚖️ License

Copyright © 2025 Ctrotech.
This project is [MIT](https://opensource.org/licenses/MIT) licensed.

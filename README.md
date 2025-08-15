# 💧 CtroDB

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Version: 1.0.0](https://img.shields.io/badge/version-1.0.0-brightgreen.svg)](https://www.npmjs.com/package/ctrodb)
[![Build Status: Passing](https://img.shields.io/badge/build-passing-brightgreen.svg)](https://github.com/ctrotech-tutor/ctrodb/actions)

**CtroDB is a modern, high-performance, and reactive client-side database from Ctrotech. Built with zero dependencies and based on Ctrotech Tutor insights, it focuses on speed, a clean API, and a powerful, live query system.**

CtroDB makes it easy to build complex, data-driven applications that feel incredibly fast and responsive. It provides a structured, relational-like API on top of the browser's native IndexedDB, giving you the best of both worlds: performance and developer experience.

---

## ✨ Key Features

*   **🚀 Super Fast:** Built to be highly performant, using indexed queries and key ranges to retrieve data in milliseconds, even with large datasets.
*   **💧 Reactive and Live:** Use the `.observe()` method on any query to get live updates in your UI. When the underlying data changes, your interface reacts automatically.
*   **🔗 Model Relations:** Define relationships between your data collections (e.g., `has_many`, `belongs_to`) and effortlessly navigate your data graph.
*   **🛠️ Clean, Modern API:** A fluent, intuitive API that makes working with a client-side database a joy. Features expressive queries like `.where('field', '>', value)` and `.orWhere(...)`.
*   **🪶 Zero Dependencies:** Written in plain, modern JavaScript with no external libraries, making it lightweight and transparent.
*   **🐛 Built-in Debugging:** Features a configurable, level-based logger to help you diagnose issues and understand the data flow in your application.
*   **🗄️ Schema-Driven:** Define a clear schema for your data to ensure consistency and enable powerful, automated database migrations.

## 📖 Installation & Usage

Install the package from NPM:
```bash
npm install ctrodb
```

### Step 1: Define Your Schema

First, create a `Schema` to define the structure of your database.

```javascript
import { Database, Schema } from 'ctrodb';

const mySchema = new Schema({
  version: 1,
  collections: {
    posts: {
      fields: {
        title: 'string',
        rating: 'number',
        isPublished: 'boolean',
      },
      indexes: ['isPublished', 'rating'], // Index for faster queries
    },
    comments: {
      fields: {
        text: 'string',
        postId: 'number', // Foreign key for the relation
      },
      indexes: ['postId'],
      relations: {
        post: { type: 'belongs_to', collection: 'posts', foreignKey: 'postId' }
      }
    }
  },
});
```

### Step 2: Initialize the Database

Create a new `Database` instance with your schema.

```javascript
import { LogLevel } from 'ctrodb';

const db = new Database({
  schema: mySchema,
  dbName: 'MyWebAppDB',
  logLevel: LogLevel.INFO, // Or LogLevel.DEBUG for more verbosity
});

// You must connect before using the database
await db.connect();
```

### Step 3: Perform Operations

Get a reference to a collection and start performing CRUD (Create, Read, Update, Delete) operations.

```javascript
const postsCollection = db.getCollection('posts');

// Create a new post
const newPost = await postsCollection.create({
  title: 'Hello CtroDB!',
  rating: 5,
  isPublished: true,
});

// Update a post
await newPost.update({ rating: 6 });
```

### Step 4: Query Your Data

Use the powerful query builder to find the data you need.

```javascript
// Find all highly-rated posts
const topPosts = await postsCollection.query()
  .where('rating', '>=', 5)
  .fetch();

// Find posts that are new OR are highly rated
const postsToShow = await postsCollection.query()
  .where('status', '==', 'new')
  .orWhere(q => q.where('rating', '>', 4))
  .fetch();
```

### Step 5: Use Reactivity to Build Live UIs

Use `.observe()` to create a live subscription to your query.

```javascript
const postsListElement = document.getElementById('posts-list');

// Observe the query for all posts
postsCollection.query().observe(allPosts => {
  // This callback will run immediately, and then again
  // every time a post is created, updated, or deleted.
  postsListElement.innerHTML = '';
  allPosts.forEach(post => {
    const li = document.createElement('li');
    li.textContent = `${post.title} (Rating: ${post.rating})`;
    postsListElement.appendChild(li);
  });
});
```

## API Reference

(API Reference section remains the same as before, detailing `Schema`, `Database`, `collection.query()`, and `model` methods.)

## ⚖️ License

This project is licensed under the **MIT License**.

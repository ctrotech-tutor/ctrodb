// hydrodb/test/integration/04-relations.test.js

import 'fake-indexeddb/auto';

import { Database } from '../../src/core/Database.js';
import { Schema } from '../../src/core/Schema.js';
import { Query } from '../../src/query/Query.js';

// A schema with a one-to-many relationship between authors and posts.
const relationsTestSchema = new Schema({
  version: 1,
  collections: {
    authors: {
      fields: { name: 'string' },
      relations: {
        // An author has many posts.
        posts: { type: 'has_many', foreignKey: 'authorId', collection: 'posts' },
      },
    },
    posts: {
      fields: {
        title: 'string',
        authorId: 'number', // The foreign key linking to the author.
      },
      indexes: ['authorId'], // An index on the foreign key is CRITICAL for performance.
      relations: {
        // A post belongs to one author.
        author: { type: 'belongs_to', foreignKey: 'authorId', collection: 'authors' },
      },
    },
  },
});

describe('Integration: Model Relations', () => {
  let db;
  let authorsCollection;
  let postsCollection;
  let author1, author2;
  let post1, post2, post3;

  // Set up the database and seed it with related data before all tests.
  beforeAll(async () => {
    const dbName = `relations_test_db_${Date.now()}`;
    db = new Database({ schema: relationsTestSchema, dbName });
    await db.connect();

    authorsCollection = db.getCollection('authors');
    postsCollection = db.getCollection('posts');

    // Create authors
    author1 = await authorsCollection.create({ name: 'J.R.R. Tolkien' });
    author2 = await authorsCollection.create({ name: 'George R.R. Martin' });

    // Create posts and associate them with authors
    post1 = await postsCollection.create({ title: 'The Hobbit', authorId: author1.id });
    post2 = await postsCollection.create({ title: 'The Lord of the Rings', authorId: author1.id });
    post3 = await postsCollection.create({ title: 'A Game of Thrones', authorId: author2.id });
  });

  afterAll(() => {
    db.disconnect();
  });

  describe('has_many relation', () => {
    it('should return a Query object when accessing the relation property', () => {
      // Accessing author1.posts should not return an array directly.
      // It should return a Query object that can be fetched later (lazy loading).
      expect(author1.posts).toBeInstanceOf(Query);
    });

    it('should fetch the correct related records', async () => {
      const tolkienPosts = await author1.posts.fetch();

      expect(tolkienPosts.length).toBe(2);
      const titles = tolkienPosts.map(p => p.title).sort();
      expect(titles).toEqual(['The Hobbit', 'The Lord of the Rings']);
    });

    it('should return an empty array if there are no related records', async () => {
      const newAuthor = await authorsCollection.create({ name: 'New Author' });
      const posts = await newAuthor.posts.fetch();
      expect(posts.length).toBe(0);
    });
  });

  describe('belongs_to relation', () => {
    it('should return a Query object when accessing the relation property', () => {
      // Accessing post1.author should return a Query object.
      expect(post1.author).toBeInstanceOf(Query);
    });

    it('should fetch the correct parent record', async () => {
      // The relation returns a query, so we fetch the first result.
      const authorOfPost1 = await post1.author.first();

      expect(authorOfPost1).toBeDefined();
      expect(authorOfPost1.id).toBe(author1.id);
      expect(authorOfPost1.name).toBe('J.R.R. Tolkien');
    });

    it('should work correctly for multiple different parent records', async () => {
      const authorOfPost3 = await post3.author.first();

      expect(authorOfPost3).toBeDefined();
      expect(authorOfPost3.id).toBe(author2.id);
      expect(authorOfPost3.name).toBe('George R.R. Martin');
    });
  });
});



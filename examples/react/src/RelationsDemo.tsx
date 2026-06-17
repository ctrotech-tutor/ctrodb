import { useMutation, useQuery } from "ctrodb/react"
import type { FormEvent } from "react"
import { useState } from "react"

interface Author {
  name: string
  email: string
  createdAt: string
}

interface Post {
  title: string
  content: string
  authorId: string
  createdAt: string
}

export function RelationsDemo() {
  const authors = useQuery<Author>("authors", (q) => q.sort({ createdAt: "desc" }))
  const posts = useQuery<Post>("posts", (q) => q.sort({ createdAt: "desc" }))
  const { create: createAuthor, error: authorError } = useMutation<Author>("authors")
  const { create: createPost, error: postError } = useMutation<Post>("posts")

  const [authorName, setAuthorName] = useState("")
  const [authorEmail, setAuthorEmail] = useState("")
  const [postTitle, setPostTitle] = useState("")
  const [postContent, setPostContent] = useState("")
  const [selectedAuthor, setSelectedAuthor] = useState("")

  const handleAddAuthor = async (e: FormEvent) => {
    e.preventDefault()
    if (!authorName.trim() || !authorEmail.trim()) return
    await createAuthor({ name: authorName.trim(), email: authorEmail.trim() })
    setAuthorName("")
    setAuthorEmail("")
  }

  const handleAddPost = async (e: FormEvent) => {
    e.preventDefault()
    if (!postTitle.trim() || !postContent.trim() || !selectedAuthor) return
    await createPost({ title: postTitle.trim(), content: postContent.trim(), authorId: selectedAuthor })
    setPostTitle("")
    setPostContent("")
  }

  const getAuthorName = (authorId: string) => {
    const author = authors.find((a) => a.id === authorId)
    return author ? author.name : "Unknown"
  }

  const postsByAuthor = (authorId: string) => posts.filter((p) => p.authorId === authorId)

  return (
    <div className="section">
      <h2>Relations (Authors & Posts)</h2>
      <p className="hint">
        Uses the <code>RelationsPlugin</code> with <code>has_many</code> (authors → posts)
        and <code>belongs_to</code> (posts → authors).
      </p>

      <div className="relation-columns">
        <div className="relation-col">
          <h3>Add Author</h3>
          <form className="todo-form" onSubmit={handleAddAuthor}>
            <input
              type="text"
              value={authorName}
              onChange={(e) => setAuthorName(e.target.value)}
              placeholder="Name"
            />
            <input
              type="email"
              value={authorEmail}
              onChange={(e) => setAuthorEmail(e.target.value)}
              placeholder="Email"
            />
            <button type="submit" disabled={!authorName.trim() || !authorEmail.trim()}>
              Add Author
            </button>
          </form>
          {authorError && <div className="error">{authorError}</div>}
        </div>

        <div className="relation-col">
          <h3>Add Post</h3>
          <form className="todo-form" onSubmit={handleAddPost}>
            <select
              value={selectedAuthor}
              onChange={(e) => setSelectedAuthor(e.target.value)}
            >
              <option value="">Select author...</option>
              {authors.map((a) => (
                <option key={a.id as string} value={a.id as string}>{a.name}</option>
              ))}
            </select>
            <input
              type="text"
              value={postTitle}
              onChange={(e) => setPostTitle(e.target.value)}
              placeholder="Post title"
            />
            <input
              type="text"
              value={postContent}
              onChange={(e) => setPostContent(e.target.value)}
              placeholder="Post content"
            />
            <button type="submit" disabled={!postTitle.trim() || !postContent.trim() || !selectedAuthor}>
              Add Post
            </button>
          </form>
          {postError && <div className="error">{postError}</div>}
        </div>
      </div>

      <div className="authors-section">
        <h3>Authors & Their Posts</h3>
        {authors.length === 0
          ? <p className="empty">No authors yet.</p>
          : (
            <div className="author-cards">
              {authors.map((author) => {
                const authorPosts = postsByAuthor(author.id as string)
                return (
                  <div key={author.id as string} className="author-card">
                    <div className="author-info">
                      <strong>{author.name}</strong>
                      <span className="email">{author.email}</span>
                    </div>
                    <div className="author-posts">
                      <strong>Posts ({authorPosts.length})</strong>
                      {authorPosts.length === 0
                        ? <p className="empty">No posts yet.</p>
                        : (
                          <ul>
                            {authorPosts.map((p) => (
                              <li key={p.id as string}>
                                <strong>{p.title}</strong>
                                <p>{p.content}</p>
                              </li>
                            ))}
                          </ul>
                        )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
      </div>
    </div>
  )
}

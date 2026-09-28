---
name: release-notes
description: Write release notes for a new version from the changes in this project. Use when the person asks for release notes or a changelog entry.
---

# Release notes

1. Find what changed. Read `CHANGELOG.md` if the project has one, and search for the version the person names. If
   there is no changelog, ask the person what changed (person.ask) rather than inventing it.
2. Group the changes under these headings, in this order, and leave out empty ones:
   - **New**: things people can do now that they could not before.
   - **Improved**: existing things that work better.
   - **Fixed**: bugs, with what the person would have noticed.
   - **Breaking**: anything that needs action when upgrading, with the action.
3. Write for the people who use the project, not for its developers: say what changed for them, in one sentence each.
   No commit hashes, ticket numbers or internal names.
4. Start with one sentence that sums up the release. Follow `references/example.md` for the shape.
5. Show the notes to the person. Write them to a file only if they ask, and name the file you would write.

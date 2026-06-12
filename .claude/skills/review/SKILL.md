---
description: Reviews code changes for formatting and other coding conventions
disable-model-invocation: true
argument-hint: 
---



# Essential
* Individual source files should be no longer than 150 lines
* File should not have circular dependencies
* Single lines should not exceed 100 characters
* Spaces, tabs, and other whitespace should be consistent throughout the entire project
* Breaking changes should be avoided.  If the complexity to make a change "non breaking" is greater than 1 week effort, it should be a wartning
* Exceptions should never be caught and swallowed, they should at least log a debug message, but typically should log a console.error.
* Give me options before making any changes
* Ask questions about approach 
# Important
* Files should ideally be under 100 lines
---
name: deck
description: Keep this thread findable and legible on the user's Deck. Use whenever you start real work, change what you are doing, get blocked on the user, or finish.
---

# The deck

The user's Deck is one searchable list of every thread. He uses it to context
switch: find a thread, remember in two seconds what it was, give you an
instruction, and move on. Two things you write make that possible.

| Tool | Effect |
| --- | --- |
| `task_note` | Sets the one line he reads to remember this thread. Also declares when you are blocked on him. |
| `task_tag` | Adds or removes tags, so this thread is findable later by something its title does not say. |

## The note

`task_note({ note: "..." })` is a standing summary, not a log entry. Replace it
whenever the answer to "where does this stand" changes. Write it for someone
who has not looked at this thread in a week.

Good: `"stripe webhook signing fixed, 126 tests green, needs review"`
Bad: `"working on it"`, `"done"`, or a sentence about what you just read.

## Being blocked

`task_note({ note: "...", blockedOn: "..." })` puts this thread at the top of
his deck under **Needs you**, in red. `blockedOn` is the one thing you need
from him, stated so he can answer it without opening the thread.

Good: `blockedOn: "the Stripe test key, or permission to skip that test"`
Bad: `blockedOn: "feedback"`

Omitting `blockedOn` on a later `task_note` clears the flag. Clear it as soon
as you are unblocked, or the deck lies to him.

## Tags

`task_tag({ add: ["..."] })`. Short and lowercase. Tag what the title does not
already say: a subsystem, a vendor, a kind of work. Do not tag the project or
the ticket, both of which are already searchable.

## Procedure

1. Set a note when you start real work, not when you finish.
2. Replace it at each real change of state.
3. Set `blockedOn` the moment you need him, and clear it the moment you do not.
4. Tag once, early, if the thread would be hard to find later.

## Rules

- One note, always current. It is replaced, never appended to.
- Do not narrate. The thread already holds the detail; this is the label on it.
- Never set `blockedOn` for something you could find out yourself.

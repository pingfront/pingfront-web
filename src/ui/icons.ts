// Icons as 24×24 path data (stroked with currentColor by the stylesheet), drawn for this widget in the
// spirit of the SF Symbols the iOS SDK uses. Several paths are joined with "|".
export const I = {
  chat: "M12 4c4.97 0 9 3.36 9 7.5S16.97 19 12 19c-.93 0-1.83-.12-2.67-.33L5 20.5l1.2-3.6C4.83 15.6 3 13.66 3 11.5 3 7.36 7.03 4 12 4z",
  close: "M6 6l12 12|M18 6L6 18",
  plus: "M12 5v14|M5 12h14",
  photo: "M4 5.5h16v13H4z|M4 15.5l4.5-4.5 4 4 2.5-2.5 5 5|M15.5 9h.01",
  up: "M12 19V6|M6.5 11.5L12 6l5.5 5.5",
  check: "M5.5 12.5l4 4 9-9",
  star: "M12 3.8l2.5 5.2 5.7.8-4.1 4 1 5.7L12 16.8l-5.1 2.7 1-5.7-4.1-4 5.7-.8z",
  gift: "M4 9h16v4H4z|M5 13h14v7H5z|M12 9v11|M12 9c-1.5-3-5-3.5-5-1.2C7 9 9 9 12 9zm0 0c1.5-3 5-3.5 5-1.2C17 9 15 9 12 9z",
  link: "M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1|M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1",
  bug: "M8 9a4 4 0 018 0v5a4 4 0 01-8 0z|M12 13v5|M4 13h4|M16 13h4|M5 8l3 2|M19 8l-3 2|M5 19l3-2|M19 19l-3-2",
  card: "M3.5 6.5h17v11h-17z|M3.5 10h17",
  idea: "M9 18h6|M10 21h4|M12 3a6 6 0 00-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0012 3z",
  info: "M12 21a9 9 0 100-18 9 9 0 000 18z|M12 11v5|M12 8h.01",
  question: "M12 21a9 9 0 100-18 9 9 0 000 18z|M9.5 9.5a2.5 2.5 0 114 2c-.9.6-1.5 1.2-1.5 2.5|M12 17h.01",
  person: "M12 12a4 4 0 100-8 4 4 0 000 8z|M4.5 20a7.5 7.5 0 0115 0",
  restore: "M4 12a8 8 0 108-8c-2.4 0-4.5 1-6 2.7L4 9|M4 4v5h5",
  lock: "M6 11h12v9H6z|M8.5 11V8a3.5 3.5 0 017 0v3",
  feedback: "M12 4c4.97 0 9 3.36 9 7.5S16.97 19 12 19c-.93 0-1.83-.12-2.67-.33L5 20.5l1.2-3.6C4.83 15.6 3 13.66 3 11.5 3 7.36 7.03 4 12 4z|M12 8.2l1.1 2.2 2.4.3-1.8 1.7.5 2.4-2.2-1.2-2.2 1.2.5-2.4-1.8-1.7 2.4-.3z",
} as const;

export const TOPIC_ICON: Record<string, string> = {
  billing: I.card,
  bug: I.bug,
  idea: I.idea,
  question: I.question,
  account: I.person,
  feedback: I.feedback,
  gift: I.gift,
  restore: I.restore,
  privacy: I.lock,
  other: I.chat,
};

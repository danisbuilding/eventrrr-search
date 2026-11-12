// Public settings for the browser. Nothing secret lives here: the Eventrrr anon key already ships in eventrrr.com's
// own frontend, and Row Level Security plus the add_from_search function decide what a signed-in person may do.
window.SEARCH_CONFIG = {
  eventrrrUrl: "https://psqedmbyopememsqrynk.supabase.co",
  eventrrrAnonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBzcWVkbWJ5b3BlbWVtc3FyeW5rIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA4MDIwNjAsImV4cCI6MjEwNjM3ODA2MH0.rKZu46rNCfo3gNaSKJFFrKZbV7y0-Z7WKX_gnsN-sME",
  eventrrrApp: "https://eventrrr.com",
  // add_from_search and my_search_keys exist in Eventrrr (Bolt run 2026-11-11).
  savingEnabled: true,
  // One of these plays at random each time someone searches from the home bar. Remove a name to retire it.
  animations: ["claws", "tilt", "wink", "snap", "tail"],
  // Shown while results load; one picked at random per search. Each frame shows for its ms, then the loop repeats.
  // Remove an entry to retire it. Images live in /assets/loaders/<file>.webp.
  loaders: [
    { label: "Pondering", frames: [["pondering-1", 1100], ["pondering-2", 1100]] },
    { label: "Researching", frames: [["researching-1", 900], ["researching-2", 170], ["researching-3", 190], ["researching-4", 240]] },
    { label: "Searching with the Eye of the Tiger", frames: [["tiger-1", 300], ["tiger-2", 300]] },
    { label: "Connecting the dots", frames: [["connecting-1", 900], ["connecting-2", 900], ["connecting-3", 900]] },
  ],
  suggestions: ["Free this weekend", "Tonight", "Date night", "Live music", "Near Roma Norte"],
};

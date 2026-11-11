// Public settings for the browser. Nothing secret lives here: the Eventrrr anon key already ships in eventrrr.com's
// own frontend, and Row Level Security plus the add_from_search function decide what a signed-in person may do.
window.SEARCH_CONFIG = {
  eventrrrUrl: "https://psqedmbyopememsqrynk.supabase.co",
  eventrrrAnonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBzcWVkbWJ5b3BlbWVtc3FyeW5rIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA4MDIwNjAsImV4cCI6MjEwNjM3ODA2MH0.rKZu46rNCfo3gNaSKJFFrKZbV7y0-Z7WKX_gnsN-sME",
  eventrrrApp: "https://eventrrr.com",
  // add_from_search and my_search_keys exist in Eventrrr (Bolt run 2026-11-11).
  savingEnabled: true,
  suggestions: ["Free this weekend", "Tonight", "Date night", "Live music", "Near Roma Norte"],
};

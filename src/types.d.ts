// The shapes of the API's JSON, shared by the server and the browser.

export interface Profile {
  name: string;
  formerName: string;
  handle: string;
  location: string;
  tagline: string;
  email: string;
  url: string;
  finger: { login: string; name: string; directory: string; shell: string; plan: string };
  profiles: SocialProfile[];
}

export interface SocialProfile {
  network: string;
  username: string;
  url: string;
  icon: string;
  aliases: string[];
}

export interface Home {
  profile: Pick<Profile, "name" | "location" | "tagline" | "handle" | "url">;
  modules: { id: ModuleId; url: string }[];
  pages: { talks: string; resume: string };
}

export type ModuleId = "whoami" | "contributions" | "src" | "name" | "talks" | "finger";

export type Block =
  | { type: "p"; html: string }
  | { type: "figure"; href: string; src: string; srcset: string; width: number; height: number; alt: string; title: string; caption: string };

export interface Whoami {
  command: string;
  blocks: Block[];
  multiDownloads: number;
}

export interface Day {
  date: string;
  count: number;
  level: number;
}

export interface Push {
  repo: string;
  sha: string;
  at: string;
}

export interface Contributions {
  command: string;
  total: number;
  longestStreak: number;
  contributions: Day[];
  since: number;
  lastPush: Push | null;
  live: boolean;
}

export interface Project {
  name: string;
  url: string;
  description: string;
  downloads: number | null;
  stars: number | null;
}

export interface Src {
  command: string;
  projects: Project[];
  total: { downloads: number; gems: number; stars: number };
  more: string;
  live: boolean;
}

export interface NameChange {
  command: string;
  commit: string;
  subject: string;
  year: number;
  notes: string[];
}

export interface Talk {
  title: string;
  event: string;
  location: string;
  date: string;
  slides: string | null;
  video: string | null;
  featured: boolean;
}

export interface Talks {
  command: string;
  speakerDeck: string;
  talks: Talk[];
  podcasts: { title: string; show: string; date: string; url: string }[];
}

export interface Finger {
  command: string;
  login: string;
  name: string;
  directory: string;
  shell: string;
  plan: string;
  mail: string;
  profiles: SocialProfile[];
}

export interface Modules {
  whoami: Whoami;
  contributions: Contributions;
  src: Src;
  name: NameChange;
  talks: Talks;
  finger: Finger;
}

// The parts of the JSON Resume schema (jsonresume.org) this site uses.
export interface Dated {
  startDate: string;
  endDate?: string;
}

export interface Resume {
  basics: {
    name: string;
    formerName: string;
    label: string;
    email: string;
    url: string;
    summary: string;
    location: { city: string; region: string; countryCode: string };
    profiles: { network: string; username: string; url: string }[];
  };
  work: (Dated & { name: string; position: string; highlights?: string[] })[];
  volunteer: (Dated & { organization: string; position: string; url?: string; summary?: string })[];
  education: (Dated & { institution: string; location: string; highlights: string[] })[];
  awards: { title: string; date: string; awarder: string; summary: string }[];
  patents: { title: string; number: string; date: string; url: string }[];
  projects: { name: string; description: string }[];
  skills: { name: string; keywords: string[] }[];
  speaking: { summary: string };
}

// Snapshot data files on disk.
export interface ProjectsFile {
  command: string;
  snapshot: string;
  totalDownloads: number;
  gemCount: number;
  more: string;
  projects: (Project & { gem: string | null; repo: string | null; with?: string })[]; // with: list right after that project
}

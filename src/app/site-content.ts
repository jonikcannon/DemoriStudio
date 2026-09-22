export type SiteSection = 'home' | 'products' | 'gallery' | 'services' | 'about' | 'contact' | 'booking';

export type NavKey = 'catalog' | 'services' | 'booking' | 'about';

export type SiteContent = {
  site: {
    brand: string;
    title: string;
    description: string;
    contactEmail: string;
    footerText: string;
    logo: string;
    socialLinks: { label: string; url: string }[];
  };
  navigation: Record<NavKey, { label: string; visible: boolean }>;
  hero: {
    eyebrow: string;
    headline: string;
    intro: string;
    ctaLabel: string;
    ctaTarget: SiteSection;
    video: string;
    poster: string;
  };
  statement: { eyebrow: string; heading: string; copy: string };
  about: {
    eyebrow: string;
    heading: string;
    /** Rendered in italics right after `heading`, e.g. "Hi, I'm" + "Jonik." */
    headingEmphasis: string;
    paragraphs: string[];
    // Empty means "use the bundled portrait" until an admin uploads one.
    portrait: string;
    ctaLabel: string;
    // Highlights shown below the About copy; `image` is optional.
    features: { title: string; description: string; image: string }[];
  };
  services: any[];
  work: any[];
  // Sites shown live in the Websites service's scrollable iframe list.
  websites: { title: string; url: string }[];
  // CSS custom properties applied at runtime (see AppComponent.applyTheme). The
  // defaults match the palette the stylesheets shipped with.
  theme: { primary: string; background: string; text: string };
  contact: { eyebrow: string; heading: string; email: string };
};

export const defaultSiteContent: SiteContent = {
  site: {
    brand: 'Demori Studios',
    title: 'Demori Studios',
    description: 'A thoughtful visual studio for people, places, and stories.',
    contactEmail: 'hello@example.com',
    footerText: 'All rights reserved.',
    logo: '',
    socialLinks: []
  },
  navigation: {
    catalog: { label: 'Catalog', visible: true },
    services: { label: 'Services', visible: true },
    booking: { label: 'Book', visible: true },
    about: { label: 'About', visible: true }
  },
  hero: {
    eyebrow: 'Photography studio',
    headline: 'Made to make you look twice.',
    intro: 'Thoughtful imagery for the places, people, and stories worth remembering.',
    ctaLabel: 'Explore the catalog',
    ctaTarget: 'products',
    video: '',
    poster: ''
  },
  statement: {
    eyebrow: 'A different perspective',
    heading: 'Images with a sense of place and feeling.',
    copy: 'From the ground to the sky, we make photographs that feel both immediate and lasting.'
  },
  about: {
    eyebrow: 'BEHIND THE LENS',
    heading: "Hi, I'm",
    headingEmphasis: 'Jonik.',
    paragraphs: [
      "I'm a photographer and licensed drone pilot with a deep passion for capturing honest moments, striking light, and perspectives people do not usually get to see.",
      'While I am newer in my professional photography journey, I bring an exceptional eye for composition, timing, and storytelling that helps each shoot feel intentional and emotionally true.',
      'I also bring 15+ years of technology leadership across the full software development lifecycle, currently serving as an Application Delivery Manager, Senior QA Automation Engineer, and Team Lead.',
      'That technical experience shapes how I approach creative work: strong preparation, repeatable quality, precision in post-processing, and a client experience built on clear communication and dependable delivery.',
      'Whether I am shooting portraits, creating aerial content, or building brand-focused visuals, my goal is simple: create images that feel personal, polished, and memorable.'
    ],
    portrait: '',
    ctaLabel: 'More about the studio',
    features: []
  },
  services: [],
  work: [],
  websites: [],
  theme: { primary: '#26362e', background: '#f4f2ec', text: '#1f211d' },
  contact: { eyebrow: "Let's make something", heading: "Have a story in mind? Let's talk.", email: 'hello@example.com' }
};

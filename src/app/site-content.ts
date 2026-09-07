export type SiteContent = {
  site: {
    brand: string;
    title: string;
    description: string;
    contactEmail: string;
    footerText: string;
    socialLinks: { label: string; url: string }[];
  };
  navigation: Record<'catalog' | 'services' | 'booking' | 'about', { label: string; visible: boolean }>;
  hero: {
    eyebrow: string;
    headline: string;
    intro: string;
    ctaLabel: string;
    ctaTarget: string;
    video: string;
    poster: string;
  };
  statement: { eyebrow: string; heading: string; copy: string };
  about: { eyebrow: string; heading: string; paragraphs: string[]; portrait: string; ctaLabel: string };
  services: any[];
  work: any[];
  contact: { eyebrow: string; heading: string; email: string };
};

export const defaultSiteContent: SiteContent = {
  site: {
    brand: 'Your Business Name',
    title: 'Your Business Name',
    description: 'A thoughtful visual studio for people, places, and stories.',
    contactEmail: 'hello@example.com',
    footerText: 'All rights reserved.',
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
  about: { eyebrow: 'Behind the lens', heading: 'About the studio', paragraphs: ['Tell your story here.'], portrait: '', ctaLabel: 'Start a conversation' },
  services: [],
  work: [],
  contact: { eyebrow: "Let's make something", heading: "Have a story in mind? Let's talk.", email: 'hello@example.com' }
};

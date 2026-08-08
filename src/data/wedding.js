export const WEDDING_DATE = new Date('2026-11-21T15:00:00+08:00');
export const RSVP_ENDPOINT = import.meta.env.VITE_RSVP_ENDPOINT || '';
export const RSVP_STORAGE_KEY = 'krisha-joe-rsvps';

export const assetPath = (fileName) => `${import.meta.env.BASE_URL}${fileName}`;

export const NAV_LINKS = [
  { href: '#details', label: 'Details' },
  { href: '#rsvp', label: 'RSVP' },
  { href: '#faq', label: 'FAQs' },
];

export const HERO = {
  title: 'Our Next Chapter',
  date: 'November 21, 2026',
  actions: [
    { href: '#rsvp', label: 'RSVP Now', className: 'primary' },
    { href: '#details', label: 'View Details', className: 'secondary' },
  ],
};

export const PRE_WEDDING = {
  eyebrow: 'Pre-Wedding Preview',
  lead: 'A glimpse of us before the big day.',
  video: assetPath('prewedding_vid_preview_krisha_joe.mp4'),
};

export const WEDDING_INFO = {
  eyebrow: 'A new forever starts here',
  lead: 'We’re so excited to celebrate this special day with the people we love most. Here are the details of our ceremony and reception to help you plan for the day.',
};

export const WEDDING_EVENTS = [
  {
    id: 'ceremony',
    icon: 'ceremony',
    title: 'The Ceremony',
    date: 'Saturday, November 21, 2026',
    time: '2:00 PM',
    placeName: 'St. Jerome Emiliani and Sta. Susana Parish',
    placeLines: [
      'St. Jerome Emiliani',
      'and Sta. Susana Parish',
      'Muntinlupa City',
    ],
    mapUrl: 'https://maps.app.goo.gl/MKpWFwrxXksBs73q6',
    wazeUrl: 'https://waze.com/ul?q=St.%20Jerome%20Emiliani%20and%20Sta.%20Susana%20Parish%2C%20Muntinlupa%20City&navigate=yes',
  },
  {
    id: 'celebration',
    icon: 'celebration',
    title: 'The Celebration',
    date: 'Saturday, November 21, 2026',
    time: '4:00 PM',
    placeName: 'The Bellevue Manila',
    placeLines: [
      'The Bellevue Manila',
      'Muntinlupa City',
    ],
    reservePlaceLine: true,
    mapUrl: 'https://maps.app.goo.gl/4XDVJ4M1LZep53La8',
    wazeUrl: 'https://waze.com/ul?q=The%20Bellevue%20Manila%2C%20Muntinlupa%20City&navigate=yes',
  },
];

export const DRESS_CODE = {
  eyebrow: 'Dress to Celebrate',
  lead: 'We invite you to celebrate with us in formal elegance, inspired by warm neutrals and muted hues.',
  attire: [
    {
      title: 'Gentlemen',
      description: 'Formal attire',
      image: assetPath('dress_gentlemen.png'),
      alt: 'Gentlemen attire illustration: black formal suit.',
    },
    {
      title: 'Ladies',
      description: 'Floor-length gown',
      image: assetPath('dress_ladies.png'),
      alt: 'Ladies attire illustration: floor-length gown.',
    },
  ],
  attireNote: 'Dress shirts are perfectly welcome for gentlemen. Jackets and ties are optional.',
  sponsorPaletteTitle: 'Principal Sponsors',
  guestPaletteTitle: 'Guests',
  sponsorColors: [
    { name: 'Warm Oat', color: '#E7D0B2' },
    { name: 'Soft Taupe', color: '#CDBCA8' },
    { name: 'Warm Beige', color: '#E7C49A' },
  ],
  guestColors: [
    { name: 'Sage', color: '#A8B39A' },
    { name: 'Soft Gray', color: '#D2CFCA' },
    { name: 'Dusty Blush', color: '#D8B4A6' },
    { name: 'Olive', color: '#A8966E' },
    { name: 'Cocoa Brown', color: '#8A6A57' },
  ],
  paletteNote: 'Please use these colors as inspiration rather than exact matches.',
  avoidTitle: 'Kindly Avoid',
  avoidItems: ['White/Ivory', 'Tube tops', 'Deep plunging necklines', 'Jeans'],
};

export const WEBSITE_PHOTO = {
  label: 'Wedding website preview',
  image: assetPath('website-pic.png'),
  screenReaderText: 'Krisha and Joe wedding website preview',
};

export const GRATITUDE_GROUPS = [
  {
    title: 'Parents of the Groom',
    columns: [
      ['Mr. Leonardo Matanguihan'],
      ['Mrs. Rosalina Matanguihan'],
    ],
  },
  {
    title: 'Parents of the Bride',
    columns: [
      ['Mr. Daniel Robles Jr.'],
      ['Mrs. Shendal Robles'],
    ],
  },
  {
    title: 'Principal Sponsors',
    columns: [
      [
        'Mr. Ricardo Chua',
        'Mr. Cecilio Duka Jr.',
        'Mr. Lito Matanguihan',
        'Mr. Carlo Enrico Silvestre',
        'Mr. Michael Tesalona',
      ],
      [
        'Mrs. Agatona Marasigan',
        'Mrs. Carolina Duka',
        'Mrs. Lila Matanguihan',
        'Mrs. Jessa Qina Silvestre',
        'Mrs. Cynthia Valencia',
      ],
    ],
  },
  {
    title: 'Candle Sponsors',
    columns: [
      ['Mr. Ricardo Chua Jr.'],
      ['Ms. Czarina Dorothy Duka'],
    ],
  },
  {
    title: 'Veil Sponsors',
    columns: [
      ['Mr. James Christian Villar'],
      ['Ms. Jane Francis Verano'],
    ],
  },
  {
    title: 'Cord Sponsors',
    columns: [
      ['Mr. Roi Jefferson Laurel'],
      ['Ms. Hannah Mae Catuiran'],
    ],
  },
];

export const GRATITUDE_HONOR_PAIR = [
  [
    {
      title: 'Best Man',
      names: ['Mr. Daniel Matanguihan'],
    },
  ],
  [
    {
      title: 'Maids of Honor',
      names: ['Ms. Krystine Pearl Robles', 'Ms. Kyle Shaniel Robles'],
    },
  ],
];

export const GRATITUDE_PAIRS = [
  [
    [
      {
        title: 'Groomsmen',
        names: [
          'Mr. Gammaniel Nelson Cabello',
          'Mr. Bryan Kenneth Desierdo',
          'Mr. Joshua Despabiladeras',
          'Mr. Reyvin John Legaspi',
          'Mr. Ivan Aaron Monteser',
        ],
      },
    ],
    [
      {
        title: 'Bridesmaids',
        names: [
          'Ms. Alyssa Tamargo',
          'Mrs. Renee Agnes Bueneventura',
          'Ms. Andrea Faye Ragos',
          'Ms. Shaira San Pedro',
        ],
      },
    ],
  ],
  [
    [
      {
        title: 'Ring Bearer',
        names: ['Mr. Nikiel Matanguihan'],
      },
      {
        title: 'Bible Bearer',
        names: ['Mr. Keone Daniel Robles'],
      },
      {
        title: 'Coin Bearer',
        names: ['Mr. Diwa Benedict Cubias'],
      },
    ],
    [
      {
        title: 'Flower Girls',
        names: [
          'Ms. Kacey Llaine Robles',
          'Ms. Roschelli Lacorte',
          'Ms. Asha Faith Torregoza',
          'Ms. Aleanna Rose Felipe',
        ],
      },
    ],
  ],
];

export const GIFTS = {
  eyebrow: 'Gifts & Wishes',
  lead: 'Your presence at our wedding is the greatest gift we could ask for.',
  note: 'Should you wish to give us something more, monetary gifts would be sincerely appreciated. Cookie, Biscuit and Smores have already volunteered to manage the funds.',
};

export const CATS = [
  {
    name: 'Cookie',
    image: assetPath('cookie.png'),
    className: 'cookieImage',
  },
  {
    name: 'Biscuit',
    image: assetPath('biscuit.png'),
    className: 'biscuitImage',
  },
  {
    name: 'Smores',
    image: assetPath('smores.png'),
    className: 'smoresImage',
  },
];

export const EMPTY_RSVP_FORM = {
  name: '',
  contactNumber: '',
  attendance: 'yes',
  guests: '1',
  additionalGuestNames: '',
  message: '',
};

export const ATTENDANCE_OPTIONS = [
  { value: 'yes', label: 'Yes, joyfully accept' },
  { value: 'no', label: 'Sorry, cannot attend' },
];

export const GUEST_OPTIONS = ['1', '2', '3', '4', '5', '6', '7', '8'].map((value) => ({
  value,
  label: value,
}));

export const RSVP_COPY = {
  eyebrow: 'Kindly respond',
  heading: 'RSVP',
  intro: 'We’d love to celebrate with you! Please let us know if you’ll be joining us by October 21, 2026.',
  alternate: 'If you prefer, you may also RSVP via text through our coordinator, Choi, at',
  contactNumber: '+63 927 214 7050',
  alternateSuffix: 'Please include your names and that you will be attending Krisha and Joe’s wedding.',
  textareaPlaceholder: 'Dietary restrictions, song requests for cocktail hour or the after-party, well wishes, or anything else you’d like us to know.',
  successMessage: 'RSVP sent. Thank you!',
  endpointErrorMessage: 'We could not reach the RSVP sheet. Your response was saved in this browser; please try again.',
  missingEndpointMessage: 'The RSVP sheet endpoint is not configured yet. Your response was saved in this browser for now.',
};

export const FAQ_ITEMS = [
  {
    question: 'What should I wear?',
    paragraphs: [
      {
        before: 'We kindly invite our guests to dress in formal attire. For our complete dress guide and color palettes, ',
        linkText: 'click here',
        href: '#dress-code',
        after: '.',
      },
    ],
  },
  {
    question: 'Can I bring a plus one?',
    paragraphs: [
      "Due to venue capacity, we are only able to accommodate the guests listed on your invitation. Thank you so much for your understanding, and we can't wait to celebrate with you!",
    ],
  },
  {
    question: 'Is there parking?',
    paragraphs: [
      'Ample parking is available at both the church and reception venue. Parking fees may apply at the reception.',
    ],
  },
  {
    question: 'What time should I arrive?',
    paragraphs: [
      'We recommend arriving 30 minutes before the ceremony to allow time for parking, registration and seating.',
    ],
  },
  {
    question: 'Can I take photos during the ceremony?',
    paragraphs: [
      'Absolutely! Feel free to take photos throughout the day. We simply ask that you be mindful of our photographers and videographers so they can capture every special moment.',
    ],
  },
  {
    question: 'Who do I contact on the wedding day?',
    paragraphs: [
      "If you have any questions before the wedding, please don't hesitate to reach out to Krisha or Joe at +63 945 485 3887.",
      'On the wedding day, our coordinator Choi will be happy to assist you at +63 917 123 4567.',
    ],
  },
  {
    question: "What's happening during cocktail hour?",
    paragraphs: [
      'While we sneak away for a few photos, please enjoy cocktails, coffee, sushi, croissants, tacos, ice cream and more before the reception begins.',
      "There will also be an on-site photo studio and personalized laser engraving for those who'd like to take home a little keepsake.",
      "And one small tip... save a little room because we've got a wonderful dinner waiting for you.",
    ],
  },
];

export const FOOTER = {
  message: 'Thank you for being part of our story. Your love, prayers and presence mean more to us than words can express. We can’t wait to celebrate this unforgettable day with you.',
  signature: 'With love, Krisha & Joe',
  date: 'November 21, 2026',
};

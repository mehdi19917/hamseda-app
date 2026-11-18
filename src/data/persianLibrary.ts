import type {
  CallerContact,
  GoalItem,
  GratitudeEntry,
  HabitItem,
  MorningMessage,
  ScheduledAnnouncement,
  VoiceName,
} from '../types/app';

export function toPersianDigits(input: string | number): string {
  const map = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'];
  return String(input).replace(/\d/g, (d) => map[Number(d)] ?? d);
}

export function getTodayKey(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function getLastNDaysKeys(days: number): {key: string; label: string; shortDay: string}[] {
  const result: {key: string; label: string; shortDay: string}[] = [];
  const weekdayFmt = new Intl.DateTimeFormat('fa-IR', {weekday: 'short'});
  const dayFmt = new Intl.DateTimeFormat('fa-IR-u-ca-persian', {day: 'numeric'});
  for (let i = days - 1; i >= 0; i--) {
    const dt = new Date();
    dt.setDate(dt.getDate() - i);
    result.push({
      key: getTodayKey(dt),
      label: dayFmt.format(dt),
      shortDay: weekdayFmt.format(dt),
    });
  }
  return result;
}

export function formatJalaliFull(date: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat('fa-IR-u-ca-persian', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      timeZone: 'Asia/Tehran',
    }).format(date);
  } catch {
    return new Intl.DateTimeFormat('fa-IR-u-ca-persian', {weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Tehran'}).format(date);
  }
}

export function getDayPart(date: Date = new Date()): 'morning' | 'midday' | 'evening' {
  const hour = date.getHours();
  if (hour >= 4 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 18) return 'midday';
  return 'evening';
}

export const VOICE_PERSONAS: {id: VoiceName; label: string; gender: 'female' | 'male'; tone: string}[] = [
  {id: 'Kore', label: 'نگین · خانم (گرم و صمیمی)', gender: 'female', tone: 'Adult female speaker. Warm, natural, affectionate Tehran Persian female voice'},
  {id: 'Zephyr', label: 'نسیم · خانم (آرام و دلنشین)', gender: 'female', tone: 'Adult female speaker. Calm, gentle, soothing Persian female voice for meditation and gratitude'},
  {id: 'Charon', label: 'رادین · آقا (بم و متین)', gender: 'male', tone: 'Adult male speaker. Deep baritone, steady, articulate bilingual Persian and English male voice'},
  {id: 'Fenrir', label: 'آرش · آقا (رسا و پرقدرت)', gender: 'male', tone: 'Adult male speaker. Strong, resonant, confident male voice ideal for caller announcements'},
  {id: 'Puck', label: 'پویا · جوان و شاداب', gender: 'male', tone: 'Youthful energetic speaker. Bright, motivating Persian voice for morning starts'},
];

export const OFFLINE_MORNING_MESSAGES: MorningMessage[] = [
  {
    id: 'msg-m1',
    dayPart: 'morning',
    title: 'طلوع یک روز هدفمند برای ما',
    message:
      'سلام به صبح روشن امروز! هر قدم کوچکی که با عشق و آگاهی برمی‌داریم، فردای زیباتری برای هردویمان می‌سازد. امروز را با لبخند، آرامش و تمرکز روی مهم‌ترین کارها شروع می‌کنیم.',
    affirmation: 'ما با آرامش، امید و پشتکار، بهترین نسخه امروزمان را می‌سازیم.',
    energyTip: 'یک لیوان آب بنوشید، پنج نفس عمیق بکشید و یک پیام کوتاه محبت‌آمیز برای همراه بفرستید.',
  },
  {
    id: 'msg-m2',
    dayPart: 'morning',
    title: 'انرژی تازه، ذهن شفاف',
    message:
      'امروز یک بوم سفید و تازه است. نیازی نیست همه کارهای جهان را یک‌جا تمام کنیم؛ کافی است سه هدف اصلی امروز را با تمام حضور قلب پیش ببریم و از کنار هم بودن لذت ببریم.',
    affirmation: 'زمان ما ارزشمند است و امروز تنها روی چیزهایی تمرکز می‌کنم که رشد و شادی می‌آورند.',
    energyTip: 'پیش از چک کردن شبکه‌های اجتماعی، ۱۰ دقیقه پیاده‌روی یا حرکات کششی انجام دهید.',
  },
  {
    id: 'msg-m3',
    dayPart: 'morning',
    title: 'قدرت شکرگذاری صبحگاهی',
    message:
      'داشتن یک همراه همدل مثل همراه و فرصت دوباره برای تلاش، بزرگ‌ترین سرمایه زندگی است. با قلبی سپاسگزار وارد امروز شوید تا درهای تازه با آرامش برایتان باز شوند.',
    affirmation: 'من قدردان لحظه‌های کوچک و بزرگ زندگی‌ام هستم و انرژی مثبت را به خانه‌مان می‌آورم.',
    energyTip: 'همین الان سه نعمت امروزتان را در دفتر شکرگذاری بنویسید.',
  },
  {
    id: 'msg-m4',
    dayPart: 'morning',
    title: 'جریان آرام و پیوسته',
    message:
      'موفقیت نتیجه شتاب‌زدگی نیست؛ نتیجه قدم‌های منظم و عاشقانه‌ای است که هر روز برمی‌داریم. امروز با حوصله، مهربانی و نظم پیش بروید.',
    affirmation: 'هر روز ما به رویاهای مشترکمان یک قدم واقعی نزدیک‌تر می‌شویم.',
    energyTip: 'اولین کار مهم امروز را به یک تایمر تمرکز ۲۵ دقیقه‌ای بسپارید.',
  },
  {
    id: 'msg-mid1',
    dayPart: 'midday',
    title: 'تجدید نفس در میانه روز',
    message:
      'نصف روز گذشته و وقت یک مکث کوتاه و مهربانانه با خودتان است. شانه‌ها را رها کنید، به دستاوردهای کوچک تا همین لحظه لبخند بزنید و با انرژی تازه ادامه بدهید.',
    affirmation: 'من در لحظه حال آرامش دارم و باقی روز را با ذهن روشن ادامه می‌دهم.',
    energyTip: 'دو دقیقه از صفحه نمایش فاصله بگیرید و یک لیوان چای یا آب تازه بنوشید.',
  },
  {
    id: 'msg-mid2',
    dayPart: 'midday',
    title: 'همراهی و انگیزه نیمروز',
    message:
      'اگر کارها سنگین به نظر می‌رسند، فقط قدم بعدی را ببینید. یادتان باشد شما تنها نیستید و لبخند همراه بهترین پاداش پایان یک روز پربار است.',
    affirmation: 'توانایی من از تردیدهایم بزرگ‌تر است و امروز را با سربلندی پیش می‌برم.',
    energyTip: 'یک پیام صوتی یا متنی کوتاه برای حال‌پرسی و انرژی دادن به همراه ارسال کنید.',
  },
  {
    id: 'msg-eve1',
    dayPart: 'evening',
    title: 'جمع‌بندی آرام و قدردانی شبانه',
    message:
      'خسته نباشید بابت تمام تلاش‌های امروز! هر آنچه انجام شد ارزشمند بود و آنچه باقی ماند را با آرامش به فردا بسپارید. امشب وقت گفت‌وگوی صمیمی و استراحت عمیق است.',
    affirmation: 'من کارهای امروز را با رضایت رها می‌کنم و شب را با آرامش در کنار همراه می‌گذرانم.',
    energyTip: 'یک یادداشت قدردانی کوچک درباره زحمات امروز همراه در دفتر شکرگذاری بنویسید.',
  },
  {
    id: 'msg-eve2',
    dayPart: 'evening',
    title: 'شامگاه سپاس و آرامش',
    message:
      'در پایان روز، بهترین عادت این است که به جای کمبودها، داشته‌ها و لحظات خوب امروز را مرور کنیم. قلب آرام، بهترین خواب و پرانرژی‌ترین فردا را می‌سازد.',
    affirmation: 'شب بخیر آرامش؛ فردا با ذهنی روشن‌تر و قلبی شادتر بیدار می‌شویم.',
    energyTip: 'فقط یک هدف طلایی برای فردا صبح یادداشت کنید تا ذهنتان سبک بخوابد.',
  },
];

export const INSTANT_ENERGY_BOOSTERS: {
  id: string;
  category: string;
  title: string;
  text: string;
}[] = [
  {
    id: 'boost-1',
    category: 'صبحگاهی',
    title: 'شروع طلایی روز',
    text: 'امروز بهترین روز برای شروع یک تغییر کوچک است. ما با آرامش و لبخند، امروز را می‌درخشیم.',
  },
  {
    id: 'boost-2',
    category: 'انرژی و انگیزه',
    title: 'رفع خستگی فوری',
    text: 'یک نفس عمیق بکش! هر تلاشی که امروز می‌کنی، بذر آرامش و موفقیت ماه‌های آینده است. ادامه بده قهرمان.',
  },
  {
    id: 'boost-3',
    category: 'عشق و همراهی',
    title: 'یادآور قدردانی از همراه',
    text: 'همراه عزیز، وجودت در روزهای من مثل نور صبح است. ممنون که با مهربانی و صبوری، خانه‌مان را پر از امید می‌کنی.',
  },
  {
    id: 'boost-4',
    category: 'تمرکز و اراده',
    title: 'فقط ۲۵ دقیقه تمرکز',
    text: 'نیازی به کامل بودن نیست؛ فقط ۲۵ دقیقه با تمام تمرکز شروع کن. حرکت، خودش انگیزه می‌سازد.',
  },
  {
    id: 'boost-5',
    category: 'شکرگذاری',
    title: 'آرامش قلب سپاسگزار',
    text: 'خدایا شکرت برای سلامتی، برای سقف امن خانه‌مان، برای لبخند همراه و برای فرصت ساختن فردایی بهتر.',
  },
  {
    id: 'boost-6',
    category: 'شبانه',
    title: 'پایان آرام روز',
    text: 'هرچه امروز گذشت کافی بود. ذهن را رها کن، لبخند بزن و با آرامش به استقبال فردای روشن برو.',
  },
];

export const PERSIAN_VOICE_PACK_ITEMS: {
  id: string;
  pack: 'morning' | 'gratitude' | 'energy' | 'caller';
  title: string;
  text: string;
  voiceName: VoiceName;
  style: string;
}[] = [
  {
    id: 'pack-m-1',
    pack: 'morning',
    title: 'سلام صبحگاهی به ما',
    text: 'صبح بخیر عزیزان ما! امروز یک روز تازه و پر از برکت است. با لبخند بیدار شوید، نفس عمیق بکشید و امروز را هدفمند و شاد شروع کنید.',
    voiceName: 'Kore',
    style: 'Warm, cheerful, fluent Tehran Persian morning greeting',
  },
  {
    id: 'pack-m-2',
    pack: 'morning',
    title: 'نیت هدفمند شروع روز (صدای آقا)',
    text: 'امروز روی کارهای مهم تمرکز می‌کنیم، با هم مهربان‌تر هستیم و برای هر قدم کوچک سپاسگزاریم. روزهای خوب را خودمان می‌سازیم.',
    voiceName: 'Charon',
    style: 'Adult male speaker. Deep baritone, encouraging, natural Persian voice',
  },
  {
    id: 'pack-g-1',
    pack: 'gratitude',
    title: 'شکرگذاری صبح و سلامتی (صدای خانم)',
    text: 'خداوندا شکرت برای نفس تازه امروز، برای سلامتی تن و آرامش جان، و برای حضور گرم همراه در زندگی من.',
    voiceName: 'Zephyr',
    style: 'Adult female speaker. Soft, peaceful, heartfelt Persian gratitude meditation',
  },
  {
    id: 'pack-g-2',
    pack: 'gratitude',
    title: 'قدردانی عاشقانه از همراه (صدای خانم)',
    text: 'همراه عزیز، ممنونم بابت تمام لحظه‌های قشنگ و لبخندهایی که به زندگی ما می‌بخشی. کنار تو هر روز معنا و آرامش بیشتری دارد.',
    voiceName: 'Kore',
    style: 'Adult female speaker. Affectionate, gentle, warm Persian voice',
  },
  {
    id: 'pack-e-1',
    pack: 'energy',
    title: 'پایان زمان تمرکز (پومودورو)',
    text: 'آفرین! بیست و پنج دقیقه تمرکز عالی به پایان رسید. الان پنج دقیقه استراحت کنید، یک لیوان آب بنوشید و لبخند بزنید.',
    voiceName: 'Fenrir',
    style: 'Adult male speaker. Bright, encouraging Persian coach',
  },
  {
    id: 'pack-e-2',
    pack: 'energy',
    title: 'بمب انرژی نیمروز (صدای آقا)',
    text: 'خستگی را کنار بگذارید! شما تا همین الان هم کارهای بزرگی انجام داده‌اید. با یک نفس عمیق، نیمه دوم روز را با قدرت تمام کنید.',
    voiceName: 'Charon',
    style: 'Adult male speaker. Motivating, deep, steady Persian voice',
  },
  {
    id: 'pack-c-1',
    pack: 'caller',
    title: 'نمونه اعلام تماس فارسی: همراه عزیز',
    text: 'تماس ورودی از طرف همراه عزیز. لطفاً گوشی را بردارید.',
    voiceName: 'Fenrir',
    style: 'Clear, pleasant Persian caller ID announcement',
  },
  {
    id: 'pack-c-2',
    pack: 'caller',
    title: 'نمونه اعلام تماس دوزبانه: Sara Design',
    text: 'تماس ورودی از طرف Sara Design. Incoming call from Sara Design.',
    voiceName: 'Charon',
    style: 'Clear bilingual Persian and English caller ID announcer',
  },
];

export const DEFAULT_GOALS: GoalItem[] = [
  {
    id: 'g-1',
    title: 'نوشتن ۳ مورد شکرگذاری صبحگاهی و نوشیدن آب',
    owner: 'both',
    category: 'purpose',
    timeBlock: 'morning',
    priority: 'high',
    completed: false,
    dateKey: getTodayKey(),
    createdAt: Date.now() - 300000,
  },
  {
    id: 'g-2',
    title: '۲۵ دقیقه تمرکز عمیق روی مهم‌ترین کار امروز',
    owner: 'man',
    category: 'work',
    timeBlock: 'morning',
    priority: 'high',
    completed: false,
    dateKey: getTodayKey(),
    createdAt: Date.now() - 200000,
  },
  {
    id: 'g-3',
    title: 'پیاده‌روی ۲۰ دقیقه‌ای یا گفتگوی عصرانه بدون موبایل',
    owner: 'zari',
    category: 'relationship',
    timeBlock: 'evening',
    priority: 'normal',
    completed: false,
    dateKey: getTodayKey(),
    createdAt: Date.now() - 100000,
  },
];

export const DEFAULT_HABITS: HabitItem[] = [
  {id: 'h-1', title: 'شکرگذاری صبحگاهی', owner: 'both', completedDates: []},
  {id: 'h-2', title: 'نوشیدن ۸ لیوان آب', owner: 'man', completedDates: []},
  {id: 'h-3', title: 'پیام انرژی‌بخش به هم', owner: 'both', completedDates: []},
  {id: 'h-4', title: '۱۵ دقیقه مطالعه هدفمند', owner: 'zari', completedDates: []},
];

export const DEFAULT_GRATITUDES: GratitudeEntry[] = [
  {
    id: 'grat-1',
    dateKey: getTodayKey(),
    jalaliDate: formatJalaliFull(new Date()),
    author: 'both',
    mood: 'grateful',
    items: [
      'بیدار شدن با سلامت و آرامش در شروع یک روز جدید',
      'همراهی، همدلی و دلگرمی بین ما',
      'فرصت یادگیری و ساختن برنامه‌های منظم‌تر برای آینده',
    ],
    loveNote: 'همراه عزیز، بودن تو کنارم بزرگ‌ترین انگیزه هر صبح من است.',
    createdAt: Date.now() - 3600000,
  },
];

export const DEFAULT_CALLERS: CallerContact[] = [
  {
    id: 'c-1',
    name: 'همراه عزیز',
    latinAlias: 'Zari',
    persianPhonetic: 'زَری جان',
    relation: 'همراه زندگی',
    template: 'تماس عاشقانه از طرف {name}. گوشی را بردارید!',
    repeatCount: 2,
    chimeStyle: 'chime',
    voiceName: 'Kore',
    favorite: true,
  },
  {
    id: 'c-2',
    name: 'مادر',
    latinAlias: 'Mom',
    persianPhonetic: 'مادَر',
    relation: 'خانواده',
    template: 'تماس ورودی از طرف {name}',
    repeatCount: 2,
    chimeStyle: 'gentle',
    voiceName: 'Zephyr',
    favorite: true,
  },
  {
    id: 'c-3',
    name: 'Sara Design',
    latinAlias: 'Sara Design',
    persianPhonetic: 'سارا دیزاین',
    relation: 'همکار پروژه',
    template: 'تماس از طرف {name}',
    repeatCount: 1,
    chimeStyle: 'classic',
    voiceName: 'Charon',
    favorite: false,
  },
  {
    id: 'c-4',
    name: 'دکتر محمدی',
    latinAlias: 'Dr. Mohammadi',
    persianPhonetic: 'دُکتر مُحَمّدی',
    relation: 'پزشک / مشاور',
    template: 'توجه: تماس از طرف {name}',
    repeatCount: 1,
    chimeStyle: 'classic',
    voiceName: 'Fenrir',
    favorite: false,
  },
  {
    id: 'c-5',
    name: 'Ali Tech Support',
    latinAlias: 'Ali Tech Support',
    persianPhonetic: 'علی تِک ساپورت',
    relation: 'فنی / کاری',
    template: 'تماس کاری از طرف {name}',
    repeatCount: 1,
    chimeStyle: 'gentle',
    voiceName: 'Charon',
    favorite: false,
  },
];

export const DEFAULT_SCHEDULES: ScheduledAnnouncement[] = [
  {
    id: 'sch-morning',
    title: 'پیام صبحگاهی و انرژی شروع روز',
    topic: 'morning',
    time: '07:30',
    enabled: true,
    voiceName: 'Kore',
    days: 'daily',
  },
  {
    id: 'sch-goals',
    title: 'مرور صوتی اهداف مهم امروز',
    topic: 'goals',
    time: '09:00',
    enabled: true,
    voiceName: 'Charon',
    days: 'daily',
  },
  {
    id: 'sch-energy',
    title: 'تجدید انرژی و نوشیدن آب نیمروز',
    topic: 'energy',
    time: '13:30',
    enabled: true,
    voiceName: 'Fenrir',
    days: 'daily',
  },
  {
    id: 'sch-gratitude',
    title: 'یادآور شکرگذاری و آرامش شبانه',
    topic: 'gratitude',
    time: '21:30',
    enabled: true,
    voiceName: 'Zephyr',
    days: 'daily',
  },
];

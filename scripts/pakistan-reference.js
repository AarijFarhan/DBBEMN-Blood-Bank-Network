/**
 * Pakistan reference data for the seeded blood-bank network.
 *
 * Why this file exists: the original seed wrote placeholder strings
 * ("SIMULATED Large Seed Blood Bank KHI 1", "+92-SIM-00000001") that made every
 * row obviously fake. A blood-bank network demo only reads as real when the
 * banks, hospitals, addresses and donor names look like they came from Pakistan,
 * so the canonical public names are pinned here and the seeder derives
 * everything else (group, component, dates, status) statistically around them.
 *
 * The blood bank and hospital names are real institutions. Addresses and
 * coordinates are the well-known campus/area locations for those institutions.
 */

/** City code -> canonical display name used in addresses. */
export const CITY_NAMES = {
  KHI: "Karachi",
  LHE: "Lahore",
  ISB: "Islamabad",
  RWP: "Rawalpindi",
  FSD: "Faisalabad",
  MUL: "Multan",
  PEW: "Peshawar",
  QUE: "Quetta",
  GUJ: "Gujranwala",
  HYD: "Hyderabad",
};

/**
 * Blood banks per city.
 *
 * Each entry: [name, area/street line, latitude, longitude].
 * Latitude/longitude sit on the real institution's approximate campus.
 */
export const BLOOD_BANKS = {
  KHI: [
    ["Chughtai Institute of Blood Transfusion & Pathology", "Block 7/8, Zafar Chambers, Clifton", 24.8138, 67.0299],
    ["Fatimid Foundation Blood Bank", "8/A, Gizri Road, Clifton", 24.8056, 67.0281],
    ["Sindh Institute of Blood Transfusion", "Near Expo Centre, University Road", 24.894, 67.089],
    ["National Institute of Blood Transfusion & Transfusion Medicine", "Hakim Ebrahim Road", 24.8556, 67.04],
    ["Jinnah Postgraduate Medical Centre Blood Bank", "Rafiqui Road, University Road", 24.887, 67.093],
    ["Aga Khan University Hospital Blood Bank", "Stadium Road", 24.891, 67.079],
    ["Indus Hospital Blood Bank", "Plot 26-C, Korangi Industrial Area", 24.834, 67.15],
    ["Bahria Foundation Hospital Blood Bank", "Bahria Town Karachi Precinct", 24.919, 67.105],
  ],
  LHE: [
    ["Punjab Institute of Blood Transfusion", "26 Gulberg III", 31.5118, 74.3419],
    ["Akhuwat Blood Transfusion Centre", "19-21 Gulberg", 31.509, 74.345],
    ["Services Hospital Blood Bank", "26 Services Road", 31.501, 74.361],
    ["Mayo Hospital Blood Bank", "Anarkali Road", 31.57, 74.35],
    ["Lahore General Hospital Blood Bank", "Shahdara", 31.57, 74.34],
    ["Rangpura Blood Bank", "Railway Road", 31.576, 74.334],
    ["Children's Hospital & Institute of Child Health", "Quaid-e-Azam Road", 31.488, 74.369],
    ["Sheikh Zayed Medical College Blood Bank", "Ravi Road", 31.479, 74.362],
  ],
  ISB: [
    ["National Institute of Blood Transfusion & Transfusion Medicine", "Sector F-6", 33.73, 73.07],
    ["Shaukat Khanum Memorial Cancer Hospital Blood Bank", "Sector G-5/1", 33.696, 73.062],
    ["Pakistan Institute of Medical Sciences Blood Bank", "Sector G-6/1", 33.707, 73.052],
    ["Combined Military Hospital Blood Bank", "Area Command, Cantt", 33.746, 73.056],
    ["Hussaini Blood Bank & Transfusion Centre", "F-8 Markaz", 33.719, 73.041],
    ["Pakistan Red Crescent Blood Transfusion Centre", "Saidpur Road", 33.709, 73.07],
  ],
  RWP: [
    ["Holy Family Hospital Blood Bank", "Saidpur Road", 33.61, 73.04],
    ["Benazir Bhutto Hospital Blood Bank", "Bhutta Road", 33.602, 73.045],
    ["Army Hospital Rawalpindi Blood Bank", "Command & Staff College Road", 33.587, 73.045],
    ["DHQ Hospital Rawalpindi Blood Bank", "Zahid Road", 33.595, 73.038],
    ["Bahria International Hospital Blood Bank", "Bahria Town Phase 4", 33.523, 73.123],
    ["Punjab Institute of Blood Transfusion Satellite Centre", "Bahria Town Phase 4", 33.524, 73.124],
  ],
  FSD: [
    ["Faisalabad Institute of Blood Transfusion", "Near Railway Hospital", 31.418, 73.079],
    ["Allied Hospital Blood Bank", "Civil Lines", 31.416, 73.072],
    ["District Hospital Faisalabad Blood Bank", "Peoples Colony No. 1", 31.429, 73.087],
    ["Government College of Medicine & Surgery Blood Bank", "Sargodha Road", 31.423, 73.083],
    ["Iqbal Blood Transfusion Centre", "Madina Town", 31.427, 73.09],
  ],
  MUL: [
    ["Multan Institute of Blood Transfusion", "Hospital Road, Shah Rukn-e-Alam", 30.193, 71.473],
    ["Nishtar Medical Complex Blood Bank", "Nishtar Road", 30.172, 71.493],
    ["Bakhtawar Teaching Hospital Blood Bank", "Medical College Road", 30.18, 71.482],
    ["Children Hospital Multan Blood Bank", "Gulgasht Road", 30.199, 71.462],
    ["Fatima Hospital Multan Blood Bank", "Shahdara Road", 30.185, 71.479],
  ],
  PEW: [
    ["Khyber Teaching Hospital Blood Bank", "University Road", 34.006, 71.578],
    ["Hayat Teaching Hospital Blood Bank", "Hayatabad Phase 2", 34.03, 71.44],
    ["Lady Reading Hospital Blood Bank", "LR Hospital Road", 34.01, 71.56],
    ["Rehman Medical College Blood Bank", "Hayatabad Phase 2", 34.026, 71.438],
    ["Peshawar Institute of Blood Transfusion", "Canal Road", 34.009, 71.57],
    ["Parbat Medical College Blood Bank", "Khyber Road", 34.008, 71.585],
  ],
  QUE: [
    ["Balochistan Institute of Blood Transfusion", "Sandeman Provincial Hospital, Jinnah Road", 30.19, 66.97],
    ["Bolan Medical Complex Blood Bank", "Quetta", 30.185, 66.975],
    ["Akram Hospital & Research Centre Blood Bank", "4-A/2-3 Block A, Cantt", 30.188, 66.981],
    ["Balochistan Institute of Nephro-Urology Blood Bank", "Mian Muhammad Bakhsh Road", 30.194, 66.965],
    ["Quetta Institute of Haematology Blood Bank", "Brewery Road", 30.183, 66.968],
  ],
  GUJ: [
    ["DHQ Hospital Gujranwala Blood Bank", "Sialkot Road", 32.17, 74.19],
    ["Gujranwala Institute of Blood Transfusion", "Model Town", 32.188, 74.195],
    ["Punjab Blood Transfusion Centre Gujranwala", "DC Colony", 32.183, 74.202],
    ["Rao Hospital Gujranwala Blood Bank", "Model Town", 32.192, 74.188],
  ],
  HYD: [
    ["Sindh Institute of Blood Transfusion Hyderabad", "Latifabad", 25.396, 68.3578],
    ["Memon Medical Institute Hospital Blood Bank", "Thandi Sarak", 25.406, 68.366],
    ["Hyderabad Blood Bank", "Qasimabad", 25.385, 68.352],
    ["City Blood Bank Hyderabad", "Auto Bhan Road", 25.39, 68.36],
    ["Indus Hospital Hyderabad Blood Bank", "Auto Bhan Road", 25.401, 68.37],
  ],
};

/**
 * Hospitals per city: the demand side of the network (requests, reservations,
 * transfusions). Each entry: [name, area/street line, latitude, longitude].
 */
export const HOSPITALS = {
  KHI: [
    ["Jinnah Postgraduate Medical Centre", "Rafiqui Road, University Road", 24.887, 67.093],
    ["Aga Khan University Hospital", "Stadium Road", 24.891, 67.079],
    ["Indus Hospital & Health Network", "Plot 26-C, Korangi Industrial Area", 24.834, 67.15],
    ["Sindh Institute of Nephro-Urology", "Rafiqui Road", 24.885, 67.091],
    ["Holy Family Hospital Karachi", "Bait-ul-Mukhtar", 24.866, 67.035],
    ["Ziauddin Hospital", "North Nazimabad Block 6", 24.939, 67.04],
    ["Saifee Hospital", "Malir", 24.892, 67.193],
  ],
  LHE: [
    ["Mayo Hospital", "Anarkali Road", 31.57, 74.35],
    ["Services Hospital", "26 Services Road", 31.501, 74.361],
    ["Lahore General Hospital", "Shahdara", 31.57, 74.34],
    ["Children's Hospital & Institute of Child Health", "Quaid-e-Azam Road", 31.488, 74.369],
    ["Sheikh Zayed Medical College", "Ravi Road", 31.479, 74.362],
    ["Gulab Devi Hospital", "Shahdara", 31.573, 74.348],
    ["Central Hospital & Institute of Psychiatry", "1 Railway Road", 31.576, 74.334],
  ],
  ISB: [
    ["Shaukat Khanum Memorial Cancer Hospital", "Sector G-5/1", 33.696, 73.062],
    ["Pakistan Institute of Medical Sciences", "Sector G-6/1", 33.707, 73.052],
    ["Combined Military Hospital", "Area Command, Cantt", 33.746, 73.056],
    ["Federal Medical College Hospital", "Area Command, Cantt", 33.747, 73.057],
    ["Capital Hospital & Research Center", "Capital Hospital Road, F-10", 33.702, 73.029],
  ],
  RWP: [
    ["Holy Family Hospital Rawalpindi", "Saidpur Road", 33.61, 73.04],
    ["Benazir Bhutto Hospital", "Bhutta Road", 33.602, 73.045],
    ["Army Hospital Rawalpindi", "Command & Staff College Road", 33.587, 73.045],
    ["DHQ Hospital Rawalpindi", "Zahid Road", 33.595, 73.038],
    ["Shifa International Hospital", "H-16/17", 33.523, 73.123],
    ["Fatima Jinnah Medical University & Hospital", "Saidpur Road", 33.603, 73.041],
  ],
  FSD: [
    ["Allied Hospital", "Civil Lines", 31.416, 73.072],
    ["District Hospital Faisalabad", "Peoples Colony No. 1", 31.429, 73.087],
    ["Government College of Medicine & Surgery Hospital", "Sargodha Road", 31.423, 73.083],
    ["Railway Hospital Faisalabad", "Railway Road", 31.413, 73.084],
    ["Faisalabad Institute of Blood Transfusion", "Near Railway Hospital", 31.418, 73.079],
  ],
  MUL: [
    ["Nishtar Medical Complex", "Nishtar Road", 30.172, 71.493],
    ["Bakhtawar Teaching Hospital", "Medical College Road", 30.18, 71.482],
    ["Children Hospital Multan", "Gulgasht Road", 30.199, 71.462],
    ["Fatima Hospital Multan", "Shahdara Road", 30.185, 71.479],
    ["Multan Institute of Blood Transfusion", "Hospital Road", 30.193, 71.473],
  ],
  PEW: [
    ["Khyber Teaching Hospital", "University Road", 34.006, 71.578],
    ["Hayat Teaching Hospital", "Hayatabad Phase 2", 34.03, 71.44],
    ["Lady Reading Hospital", "LR Hospital Road", 34.01, 71.56],
    ["Rehman Medical College Hospital", "Hayatabad Phase 2", 34.026, 71.438],
    ["Parbat Medical College Hospital", "Khyber Road", 34.008, 71.585],
  ],
  QUE: [
    ["Bolan Medical Complex", "Quetta", 30.185, 66.975],
    ["Akram Hospital & Research Centre", "4-A/2-3 Block A, Cantt", 30.188, 66.981],
    ["Balochistan Institute of Nephro-Urology", "Mian Muhammad Bakhsh Road", 30.194, 66.965],
    ["Sandeman Provincial Hospital", "Jinnah Road", 30.19, 66.97],
    ["Quetta Institute of Haematology", "Brewery Road", 30.183, 66.968],
  ],
  GUJ: [
    ["DHQ Hospital Gujranwala", "Sialkot Road", 32.17, 74.19],
    ["Rao Hospital Gujranwala", "Model Town", 32.192, 74.188],
    ["Combined Military Hospital Gujranwala", "CMH Road", 32.205, 74.185],
    ["Gujranwala Institute of Blood Transfusion", "Model Town", 32.188, 74.195],
  ],
  HYD: [
    ["Sindh Institute of Blood Transfusion Hyderabad", "Latifabad", 25.396, 68.3578],
    ["Memon Medical Institute Hospital", "Thandi Sarak", 25.406, 68.366],
    ["Indus Hospital Hyderabad", "Auto Bhan Road", 25.401, 68.37],
    ["City Hospital Hyderabad", "Auto Bhan Road", 25.39, 68.36],
  ],
};

/** Residential localities per city, used to build donor street addresses. */
export const LOCALITIES = {
  KHI: ["Clifton", "Gulshan-e-Iqbal", "PECHS", "DHA Phase 6", "North Nazimabad", "Federal B Area", "Saddar", "Orangi Town", "Malir", "Korangi", "Gora Qadirstan", "Sher Shah", "PECHS Extension", "Tipu Sultan Road", "Adamjee Nagar"],
  LHE: ["Gulberg", "DHA Phase 5", "Model Town", "Johar Town", "Cantt", "Shahdara", "Samanabad", "Allama Iqbal Town", "Walled City", "Data Ganj Bakhsh", "Baghbanpura", "Shalimar", "Green Town", "Faisal Town", "Paragon City"],
  ISB: ["Blue Area", "F-6/1", "F-7/2", "F-8/3", "F-10/2", "I-8/4", "I-10/1", "Saidpur", "G-9 Markaz", "E-11/2", "Chakri Interchange", "Tahrera Road", "Humayun Road", "Bagh Jogian", "Qureshi Mohalla"],
  RWP: ["Bahria Town Phase 4", "DHA Phase 2", "Satellite Town", "Saddar", "Chaklala", "Askari X", "Gulzar-e-Quaid", "Saidpur Road", "Kuri Road", "Wapda Town", "Liaquat Ali Road", "Bank Road", "PWD Housing", "Green Avenue"],
  FSD: ["Madina Town", "Peoples Colony No. 1", "Askari", "Cantt", "Railway Bazar", "Model Town", "Sargodha Road", "Gorakh Nagar", "D Ground", "Johar Town", "Shahbaz Colony", "Kohinoor Town", "Eshram Colony", "Azam Cloth Market"],
  MUL: ["Cantt", "Shah Rukn-e-Alam", "Gulgasht", "University Town", "Hasilpur", "Officers Colony", "Shahdara", "Muzafar Khan Road", "Bagh Para", "Sara Dan", "Saddar", "Kharpat Colony"],
  PEW: ["Hayatabad", "University Town", "Canal Road", "Sadoat", "Warsak Road", "Ring Road", "Shahdara", "Jalan Bazar", "Gulshan Town", "Regent Park", "Rahat Plaza", "Qissa Khwani Bazaar", "Amin Khan Road", "Citi Housing"],
  QUE: ["Askari Ville", "Cantt", "Satellite Town", "Muslim Town", "Chaman Town", "Brewery Road", "Jinnah Road", "Sakhi Sarak", "Jalalabad", "New Quetta", "Shah Alam Market", "P Colony"],
  GUJ: ["Model Town", "Peoples Colony", "DC Colony", "Satellite Town", "Wazirabad Road", "Shahpur", "College Road", "Rahmat Road", "New Satellite Town", "Canal Road", "Gulshan Colony"],
  HYD: ["Qasimabad", "Hussainabad", "Latifabad Unit 6", "Latifabad Unit 8", "Latifabad Unit 9", "Auto Bhan Road", "Phase 1 Qasimabad", "Saddar", "Hirabad", "Kali Mor", "Shamsabad", "Citizen Colony"],
};

/** Street lines per city for donor addresses. */
export const STREETS = {
  KHI: ["Shahrah-e-Faisal", "Shahrah-e-Quaid-e-Azam", "Main Boulevard", "Gulberg Road", "Zafar Chambers", "Tariq Road", "Rafi Road", "Bait-ul-Mukhtar Road", "University Road", "Hakim Ebrahim Road", "PECHS Road", "Federal B Area Road"],
  LHE: ["Main Boulevard", "Jail Road", "Mall Road", "Canal Road", "Ravi Road", "Ferozepur Road", "Shahrah-e-Quaid-e-Azam", "Railway Road", "University Road", "Gulberg III", "Data Ganj Bakhsh Road", "Samanabad Road"],
  ISB: ["Jinnah Avenue", "Constitution Avenue", "Takhsum Road", "Faisal Avenue", "I.I. Chundrigar Road", "Blue Area Road", "Shahid-e-Millat Road", "Kasturi Road", "F-10 Markaz", "Saidpur Road", "Islamabad Express Highway"],
  RWP: ["Bank Road", "Liaquat Ali Road", "Saidpur Road", "Kuri Road", "Peshawar Road", "Main Bazaar", "Ghanta Ghar Road", "Command & Staff College Road", "Zahid Road", "Ahmed Road", "Belt Road"],
  FSD: ["Railway Road", "Sargodha Road", "Jaranwala Road", "College Road", "Ghanta Ghar Road", "Civil Lines", "Kachehri Road", "Kotwali Road", "Clock Tower Road", "Madina Town Road"],
  MUL: ["Nishtar Road", "Hospital Road", "Shah Rukn-e-Alam Road", "Gulgasht Road", "Abdali Road", "Muzafar Khan Road", "Bahawalpur Road", "Medical College Road", "Kassab Road", "Lalazar Road"],
  PEW: ["University Road", "Canal Road", "Warsak Road", "Ring Road", "Khyber Road", "Jalan Bazar", "Qissa Khwani Road", "Lady Reading Hospital Road", "Rahat Plaza Road", "Park Road", "Gulshan Road"],
  QUE: ["Jinnah Road", "Brewery Road", "Mian Muhammad Bakhsh Road", "Zarghun Road", "Sakhi Sarak Road", "Alamdar Road", "Chaman Town Road", "Shah Alam Road", "Rana Medical Complex Road"],
  GUJ: ["Sialkot Road", "Wazirabad Road", "Model Town Road", "DC Colony Road", "Grand Trunk Road", "College Road", "Rahmat Road", "Canal Road", "Main Bazaar Road"],
  HYD: ["Auto Bhan Road", "Thandi Sarak", "Qasimabad Road", "Latifabad Road", "Hirabad Road", "Saddar Road", "Hussainabad Road", "University Road", "Citizen Colony Road", "Kali Mor Road"],
};

/**
 * Pakistani given names, ordered most-common first so the seeder's skewed
 * index produces a realistic frequency distribution rather than a flat one.
 */
export const MALE_FIRST_NAMES = [
  "Muhammad", "Ahmed", "Ali", "Hassan", "Usman", "Bilal", "Imran", "Kashif", "Adnan", "Salman",
  "Fahad", "Zeeshan", "Junaid", "Asad", "Tauseef", "Nadeem", "Kamran", "Shahid", "Tanveer", "Waqas",
  "Ahsan", "Farhan", "Owais", "Hamza", "Daniyal", "Areeb", "Muzammil", "Rizwan", "Shafiq", "Yasin",
  "Sohail", "Faisal", "Arif", "Wajid", "Zubair", "Aamir", "Sarmad", "Talha", "Bilal", "Haris",
  "Nauman", "Rehan", "Sajid", "Tariq", "Yasir", "Zahid", "Danish", "Ehsan", "Furqan", "Ghulam",
  "Haris", "Irfan", "Jamshed", "Khurram", "Latif", "Mansoor", "Nadeem", "Owais", "Qais", "Rasheed",
];

export const FEMALE_FIRST_NAMES = [
  "Fatima", "Ayesha", "Maryam", "Zainab", "Sadia", "Nadia", "Hina", "Saba", "Rabia", "Kiran",
  "Amna", "Sania", "Farhana", "Sidra", "Zarina", "Saima", "Bushra", "Naheed", "Tehmina", "Ruqia",
  "Shazia", "Uzma", "Sumbul", "Nargis", "Perveen", "Mukhtara", "Shahida", "Rehana", "Nasreen", "Laila",
  "Asma", "Nasim", "Shabana", "Tahira", "Uzma", "Zubaida", "Hafsa", "Iqra", "Mahnoor", "Sadaf",
  "Wajiha", "Ambreen", "Gulnaz", "Mehwish", "Rukhsana", "Shumaila", "Kanwal", "Naila", "Sohail",
  "Iqbal", "Shazia", "Husna", "Rukhsar", "Saira",
];

/** Family names / clan names, ordered most-common first. */
export const SURNAMES = [
  "Khan", "Ahmed", "Ali", "Malik", "Butt", "Chaudhry", "Sheikh", "Awan", "Mughal", "Qureshi",
  "Ansari", "Abbasi", "Durrani", "Baloch", "Rajput", "Bhatti", "Gujjar", "Jatt", "Sandhu", "Rathore",
  "Khattak", "Lodhi", "Chishti", "Naqvi", "Kazmi", "Rizvi", "Siddiqui", "Hashmi", "Nadeem", "Iqbal",
  "Farooq", "Aslam", "Younis", "Akram", "Sadiq", "Bashir", "Yousaf", "Nawaz", "Sharif", "Zaman",
  "Kamal", "Yasin", "Zafar", "Javed", "Munir", "Rasheed", "Sabir", "Tariq", "Waheed", "Zahid",
  "Majeed", "Hameed", "Sadiq", "Rafiq", "Shahid", "Hassan", "Raza", "Sajjad", "Qadir", "Hussain",
  "Amir", "Saleem", "Rashid", "Jamil", "Umar", "Salman", "Haroon", "Imtiaz", "Khalid", "Shahid",
];

/** Pakistani mobile prefixes (03xx) used to build plausible contact numbers. */
export const MOBILE_PREFIXES = [
  "0300", "0301", "0302", "0303", "0304", "0305", "0306", "0307",
  "0310", "0311", "0312", "0313", "0314", "0315", "0316", "0317",
  "0320", "0321", "0322", "0323", "0324", "0325", "0326", "0327",
  "0330", "0331", "0332", "0333", "0334", "0335", "0336", "0337",
  "0340", "0341", "0342", "0343", "0344", "0345", "0346", "0347",
  "0366", "0380", "0381", "0382", "0383",
];

/** Common reasons a blood unit leaves inventory, per status. */
export const STATUS_REASONS = {
  RESERVED: ["Reserved for elective surgery", "Reserved for dialysis patient", "Reserved for trauma case", "Reserved for obstetrics unit", "Reserved for paediatric ward", "Reserved for oncology patient"],
  DISPATCHED: ["Dispatched to hospital blood bank", "Transport to hospital transfusion centre", "Airlifted for emergency requirement", "Courier dispatch to district hospital"],
  TRANSFUSED: ["Transfused successfully", "Transfused - single dose", "Transfused - multiple units given", "Transfused after cross-match"],
  EXPIRED: ["Expired - shelf life exceeded", "Expired - 42 day PRBC limit reached", "Expired - 7 day platelet limit reached", "Expired - frozen plasma shelf life reached"],
  DISCARDED: ["Discarded - haemolysis detected", "Discarded - failed screening test", "Discarded - bag integrity failure", "Discarded - cold chain breach", "Discarded - wrong component prepared"],
  QUARANTINE: ["Awaiting serology clearance", "Quarantine - reactive screening pending", "Awaiting donor re-call for testing", "Quarantine - pending blood group confirmation"],
};

/** Notes used on donation records to look like real collection paperwork. */
export const DONATION_NOTES = [
  "Whole blood donated, informed consent signed",
  "Voluntary donation - routine collection",
  "Replacement donation - previous unit issued",
  "Regular donor - second donation this year",
  "Camp collection - mobile blood drive",
  "Camp collection - university blood drive",
  "Donor registered with blood bank, first donation",
  "Donor weight and vitals recorded, fit for donation",
  "Aphersis linked collection",
  "Plasma for cryoprecipitate recovered",
];

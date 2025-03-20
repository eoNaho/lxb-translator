# 🌍 .lxb File Translator

This project allows automatic translation of `.lxb` files using the Google Translate API, with support for caching and special text preservation.

---

## ✨ Features

- 🚀 **Automatic translation** of texts in binary files
- 💾 **Persistent cache** to avoid retranslation
- ⏸️ **Automatic pause** when request limits are reached
- 🔒 **Preserves texts between `$$`** (e.g., `$BUT_A$`)
- 📊 **Detailed progress statistics**
- 🔄 **Resumes from where it left off** in interrupted executions

---

## 📋 Requirements

- **Node.js 18+**
- **Google Translate API key** (optional)
- **OpenAI API key** (optional)
- **Deepseek API key** (optional)
- **OpenRounter API key** (optional)

---

## ⚙️ Installation

1. **Clone the repository:**

   ```bash
   git clone https://github.com/eoNaho/lxb-translator.git
   cd lxb-translator
   ```

2. **Install dependencies:**

   ```bash
   npm install
   ```

3. **Create the `.env` file (optional for more requests):**
   ```env
   GOOGLE_API_KEY_FILE=path/to/your/credential.json
   GOOGLE_PROJECT_ID=your-project-id
   OPENAI_API_KEY=your-key
   DEEPSEEK_API_KEY=your-key
   OPENROUTER_API_KEY=your-key
   ```

---

## 🚀 How to Use

1. **Place your `.lxb` file in the project root** with the name `exemple.lxb`.
2. **Run the translator:**

   ```bash
   npx ts-node src/index.ts
   ```

3. The translated file will be saved as `exemple_pt.lxb`.

---

## 📁 Project Structure

```
lxb-translator/
├── src/
│   ├── input/
│   │   └── exemple.lxb       # Input file
│   ├── output/
│   │   └── exemple_pt.lxb    # Translated file
│   └── index.ts              # Main code
├── cache.json                # Translation cache
├── .env                      # Environment configurations
├── package.json              # Project dependencies
└── README.md                 # This file
```

---

## 🔧 Configuration

Edit the `src/index.ts` file to adjust:

- **Request limit** (`requestLimit`)
- **Cooldown time** (`cooldownTime`)
- **Input/output file names**
- **Language he will translate** (`translateOptions`)

---

## 📝 Usage Example

**Input (`exemple.lxb`):**

```text
"Press $BUT_A$ to jump"
"Use $BUT_DPAD_R_RIGHT$ to move"
```

**Output (`exemple_pt.lxb`):**

```text
"Pressione $BUT_A$ para pular"
"Use $BUT_DPAD_R_RIGHT$ para mover"
```

---

## 💡 Tips

- 🗑️ To **reset the cache**, delete the `cache.json` file
- 🔍 Use **HxD** to inspect the translated file
- ✏️ Adjust `minStringLength` to capture shorter texts

---

## 📜 License

This project is licensed under the [**MIT License**](https://github.com/eoNaho/lxb-translator/blob/main/LICENSE) - see the [`LICENSE`](https://github.com/eoNaho/lxb-translator/blob/main/LICENSE) file for details.

Made with ❤️ by [**eoNaho**](https://github.com/eoNaho)

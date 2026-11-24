use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::Read;
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex};
use tauri::{AppHandle, Manager, Runtime};

const PREFERENCE_FILE: &str = "language.json";
const MENU_PREFIX: &str = "bodhi-language-";

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub(crate) enum Locale {
    #[default]
    #[serde(rename = "en-US")]
    English,
    #[serde(rename = "zh-CN")]
    SimplifiedChinese,
    #[serde(rename = "zh-TW")]
    TraditionalChinese,
    #[serde(rename = "fr-FR")]
    French,
    #[serde(rename = "ja-JP")]
    Japanese,
    #[serde(rename = "hi-IN")]
    Hindi,
}

static MESSAGES: LazyLock<[BTreeMap<String, String>; 6]> = LazyLock::new(|| {
    [
        include_str!("../../bodhi-splash/locales/en-US.json"),
        include_str!("../../bodhi-splash/locales/zh-CN.json"),
        include_str!("../../bodhi-splash/locales/zh-TW.json"),
        include_str!("../../bodhi-splash/locales/fr-FR.json"),
        include_str!("../../bodhi-splash/locales/ja-JP.json"),
        include_str!("../../bodhi-splash/locales/hi-IN.json"),
    ]
    .map(|catalog| serde_json::from_str(catalog).expect("valid bundled Bodhi translations"))
});

impl Locale {
    pub(crate) const ALL: [Self; 6] = [
        Self::English,
        Self::SimplifiedChinese,
        Self::TraditionalChinese,
        Self::French,
        Self::Japanese,
        Self::Hindi,
    ];

    pub(crate) const fn tag(self) -> &'static str {
        match self {
            Self::English => "en-US",
            Self::SimplifiedChinese => "zh-CN",
            Self::TraditionalChinese => "zh-TW",
            Self::French => "fr-FR",
            Self::Japanese => "ja-JP",
            Self::Hindi => "hi-IN",
        }
    }

    pub(crate) fn menu_id(preference: Option<Self>) -> String {
        format!("{MENU_PREFIX}{}", preference.map_or("system", Self::tag))
    }

    pub(crate) fn from_menu_id(id: &str) -> Option<Option<Self>> {
        match id.strip_prefix(MENU_PREFIX)? {
            "system" => Some(None),
            tag => Self::ALL
                .into_iter()
                .find(|locale| locale.tag() == tag)
                .map(Some),
        }
    }

    pub(crate) fn text(self, key: &'static str) -> &'static str {
        self.messages()
            .get(key)
            .or_else(|| Self::English.messages().get(key))
            .map_or(key, String::as_str)
    }

    pub(crate) fn messages(self) -> &'static BTreeMap<String, String> {
        &MESSAGES[self as usize]
    }

    pub(crate) fn format(self, key: &'static str, values: &[(&str, &str)]) -> String {
        let mut remaining = self.text(key);
        let mut output = String::new();
        while let Some((prefix, placeholder)) = remaining.split_once('{') {
            let Some((name, suffix)) = placeholder.split_once('}') else {
                break;
            };
            output.push_str(prefix);
            match values.iter().find(|(key, _)| *key == name) {
                Some((_, value)) => output.push_str(value),
                None => {
                    output.push('{');
                    output.push_str(name);
                    output.push('}');
                }
            }
            remaining = suffix;
        }
        output.push_str(remaining);
        output
    }

    fn from_system_tag(tag: &str) -> Option<Self> {
        let tag = tag.trim().replace('_', "-").to_ascii_lowercase();
        let (base, variants) = tag.split_once('-').unwrap_or((&tag, ""));
        match base {
            "zh" if variants.split('-').any(|part| part == "hans") => Some(Self::SimplifiedChinese),
            "zh" if variants
                .split('-')
                .any(|part| matches!(part, "hant" | "tw" | "hk" | "mo")) =>
            {
                Some(Self::TraditionalChinese)
            }
            "zh" => Some(Self::SimplifiedChinese),
            "en" => Some(Self::English),
            "fr" => Some(Self::French),
            "ja" => Some(Self::Japanese),
            "hi" => Some(Self::Hindi),
            _ => None,
        }
    }

    fn resolve_system(tags: impl IntoIterator<Item = impl AsRef<str>>) -> Self {
        tags.into_iter()
            .find_map(|tag| Self::from_system_tag(tag.as_ref()))
            .unwrap_or_default()
    }
}

pub(crate) struct Language {
    directory: Option<PathBuf>,
    system: Locale,
    preference: Mutex<Option<Locale>>,
}

impl Language {
    pub(crate) fn load<R: Runtime>(app: &AppHandle<R>) -> Self {
        Self::with_system(
            app.path().app_local_data_dir().ok(),
            Locale::resolve_system(sys_locale::get_locales()),
        )
    }

    fn with_system(directory: Option<PathBuf>, system: Locale) -> Self {
        let preference = directory.as_ref().and_then(|dir| {
            let file = File::open(dir.join(PREFERENCE_FILE)).ok()?;
            if file.metadata().ok()?.len() > 128 {
                return None;
            }
            serde_json::from_reader::<_, Option<Locale>>(file.take(128))
                .ok()
                .flatten()
        });
        Self {
            directory,
            system,
            preference: Mutex::new(preference),
        }
    }

    pub(crate) fn preference(&self) -> Option<Locale> {
        *self
            .preference
            .lock()
            .unwrap_or_else(|error| error.into_inner())
    }

    pub(crate) fn resolve(&self, preference: Option<Locale>) -> Locale {
        preference.unwrap_or(self.system)
    }

    pub(crate) fn set_preference(&self, preference: Option<Locale>) -> anyhow::Result<()> {
        let mut stored = self
            .preference
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if *stored != preference {
            let directory = self.directory.as_ref().ok_or_else(|| {
                anyhow::anyhow!("Bodhi's local settings directory is unavailable")
            })?;
            fs::create_dir_all(directory)?;
            let file = tempfile::NamedTempFile::new_in(directory)?;
            serde_json::to_writer(file.as_file(), &preference)?;
            file.as_file().sync_all()?;
            file.persist(directory.join(PREFERENCE_FILE))?;
            *stored = preference;
        }
        Ok(())
    }
}

pub(crate) fn active<R: Runtime>(app: &AppHandle<R>) -> Locale {
    app.try_state::<Language>()
        .map(|language| language.resolve(language.preference()))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_locale_uses_the_first_supported_preference() {
        assert_eq!(
            Locale::resolve_system(["de-DE", "zh_Hant_HK"]),
            Locale::TraditionalChinese
        );
        assert_eq!(
            Locale::resolve_system(["zh-Hans-TW"]),
            Locale::SimplifiedChinese
        );
        assert_eq!(Locale::resolve_system(["fr-CA", "en-GB"]), Locale::French);
        assert_eq!(Locale::resolve_system(["C", "ko-KR"]), Locale::English);
    }

    #[test]
    fn language_choice_persists_and_system_mode_uses_the_next_system_locale() {
        let directory = tempfile::tempdir().unwrap();
        let path = Some(directory.path().to_owned());
        let language = Language::with_system(path.clone(), Locale::English);
        language.set_preference(Some(Locale::Japanese)).unwrap();
        let reopened = Language::with_system(path.clone(), Locale::French);
        assert_eq!(reopened.resolve(reopened.preference()), Locale::Japanese);
        reopened.set_preference(None).unwrap();
        let reopened = Language::with_system(path.clone(), Locale::Hindi);
        assert_eq!(reopened.resolve(reopened.preference()), Locale::Hindi);

        fs::write(directory.path().join(PREFERENCE_FILE), b"\"unrecognized\"").unwrap();
        let invalid = Language::with_system(path, Locale::TraditionalChinese);
        assert_eq!(
            invalid.resolve(invalid.preference()),
            Locale::TraditionalChinese
        );
    }

    #[test]
    fn catalog_and_menu_identifiers_are_aligned() {
        fn placeholders(text: &str) -> Vec<&str> {
            let mut names = text
                .split('{')
                .skip(1)
                .filter_map(|placeholder| placeholder.split_once('}').map(|(name, _)| name))
                .collect::<Vec<_>>();
            names.sort_unstable();
            names
        }
        let english = Locale::English.messages();
        for locale in Locale::ALL {
            assert_eq!(
                Locale::from_menu_id(&Locale::menu_id(Some(locale))),
                Some(Some(locale))
            );
            assert_eq!(serde_json::to_value(locale).unwrap(), locale.tag());
            assert_eq!(
                locale.messages().keys().collect::<Vec<_>>(),
                english.keys().collect::<Vec<_>>()
            );
            for (key, message) in locale.messages() {
                assert!(!message.trim().is_empty(), "{locale:?}: {key}");
                assert_eq!(
                    placeholders(message),
                    placeholders(&english[key]),
                    "{locale:?}: {key}"
                );
            }
        }
        assert_eq!(Locale::from_menu_id(&Locale::menu_id(None)), Some(None));
        assert_eq!(Locale::from_menu_id("bodhi-language-unknown"), None);
    }

    #[test]
    fn inserted_values_are_kept_verbatim() {
        assert_eq!(
            Locale::French.format("updates.lastCheck", &[("date", "24/11/2026 {literal}")]),
            "Dernière vérification le 24/11/2026 {literal}"
        );
    }
}

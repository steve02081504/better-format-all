# format-all

[English](README.md) · [简体中文](README.zh-cn.md) · [日本語](README.ja.md) · **Français** · [Español](README.es.md) · [हिंदी](README.hi.md)

Formatez tous les fichiers suivis par git ou non validés d'un dossier avec leur formateur par défaut, directement depuis le menu contextuel de l'Explorateur.

## Fonctionnalités

- **Formater tout un dossier** — cliquez avec le bouton droit sur n'importe quel dossier de l'Explorateur et choisissez **Formater tous les fichiers du dossier**.
- **Uniquement ce qui a changé** — la première exécution formate tous les fichiers suivis ; les suivantes ne formatent que les fichiers modifiés depuis le dernier commit entièrement formaté, plus tous les fichiers non suivis et non ignorés par git. Les modifications non validées sont toujours prises en compte.
- **Travail minimal par sous-chemin** — le dernier commit entièrement formaté est mémorisé par sous-chemin dans `.git/format-all.json`, donc un sous-dossier formaté seul n'est pas refait lorsque vous formatez son parent.
- **Le formateur par défaut** — les fichiers passent par _Format Document_, donc le `editor.defaultFormatter` configuré est utilisé. L'extension ne choisit jamais silencieusement le premier formateur à votre place.
- **Annulation sûre** — une notification de progression permet d'annuler. Une exécution annulée ou partiellement en échec ne met **pas** à jour la référence, donc l'exécution suivante voit encore tous les fichiers non formatés.
- **Interface localisée** — suit la langue d'affichage de VS Code.

## Utilisation

1. Dans l'Explorateur, cliquez avec le bouton droit sur un dossier d'un dépôt git.
2. Choisissez **Formater tous les fichiers du dossier**.
3. Chaque fichier est ouvert, formaté avec son formateur par défaut, enregistré puis fermé.

Un clic droit sur un dossier qui n'est pas dans un dépôt git signale une erreur et ne fait rien.

## Fonctionnement de la référence

- L'état est stocké dans `.git/format-all.json` (configurable via `formatAll.stateFile`). Il associe un chemin relatif au dépôt au SHA du commit auquel ce chemin a été entièrement formaté pour la dernière fois ; la racine du dépôt est la chaîne vide `''`.
- Un fichier utilise comme référence le **plus profond ancêtre enregistré ou lui-même**. Quand un chemin est entièrement formaté, les entrées plus spécifiques situées en dessous sont supprimées — l'entrée parente les couvre déjà.
- Sans référence, tous les fichiers suivis de la cible sont formatés. Avec une référence, la sélection est `git diff <sha>` **par rapport à l'espace de travail** (les modifications non validées comptent donc) plus les fichiers non suivis et non ignorés.
- La référence n'est écrite qu'une fois la cible entièrement terminée (rien d'annulé, aucun échec).

## Paramètres

| Paramètre                    | Défaut            | Description                                                   |
| ---------------------------- | ----------------- | ------------------------------------------------------------- |
| `formatAll.stateFile`        | `format-all.json` | Nom du fichier écrit dans le répertoire `.git` du dépôt.      |
| `formatAll.includeUntracked` | `true`            | Formate aussi les fichiers non suivis et non ignorés par git. |

## Prérequis

- Visual Studio Code 1.100.0 ou plus récent.
- `git` dans le `PATH`.
- Un formateur par défaut configuré pour les langages à formater (`editor.defaultFormatter`) ; les fichiers dont le langage n'a pas de formateur sont laissés tels quels.

## Localisation

| Langue                | Locale        |
| --------------------- | ------------- |
| Anglais (États-Unis)  | `en`, `en-US` |
| Anglais (Royaume-Uni) | `en-gb`       |
| 简体中文              | `zh-cn`       |
| 日本語                | `ja`          |
| Français              | `fr`          |
| Español               | `es`          |
| हिंदी                 | `hi`          |

Les titres de commandes et les notifications suivent la langue d'affichage de VS Code.

## Développement

```powershell
npm install   # une fois
npm test      # exécute la suite de tests sur le VS Code local
npm run build # empaquette l'extension et l'installe localement
```

Voir `AGENTS.md` pour les notes de maintenance.

## Licence

[LGPL-3.0-only](LICENSE.md)

import crypto from 'crypto'
import path from 'path'
import fs from 'fs'

import { nanoid, customAlphabet } from 'nanoid'
import cheerio from 'cheerio'

import CustomExporter from './CustomExporter'
import Settings from './Settings'
import Note from './Note'
import Deck from './Deck'

const replaceAll =  (original: string, oldValue: string, newValue: string) => {
  // escaping all special Characters
  const escaped = oldValue.replace(/[{}()[\].?*+$^\\/]/g, "\\$&");
  // creating regex with global flag
  const reg = new RegExp(escaped, 'g');
  return original.replace(reg, newValue);
}

export class DeckParser {

  globalTags: any
  firstDeckName: string
  fileName: string
  settings: Settings
  payload: any[]
  files:  any[]

  public get name () {
    return this.payload[0].name
  }

  constructor (fileName: any, settings: Settings, files: any) {
    this.settings = settings
    this.files = files || []
    this.firstDeckName = fileName
    this.payload = this.handleHTML(fileName, this.files[fileName], this.settings.deckName, [])
    this.fileName = fileName
  }

  findNextPage (href: string | undefined, fileName: string) {
    if (!href) {
      console.log('skipping next page, due to href being', href)
      return
    }

    const nextFileName: any = global.decodeURIComponent(href)
    const pageContent = this.files[nextFileName]
    const match: any = Object.keys(this.files).find($1 => $1.match(nextFileName))
    if (match) {
      return this.files[match]
    }
    return pageContent
  }

  noteHasCherry (note: Note) {
    const cherry = '&#x1F352;'
    return note.name.includes(cherry) ||
    note.back.includes(cherry) ||
    note.name.includes('🍒') ||
    note.back.includes('🍒')
  }


  findToggleLists (dom: cheerio.Root) {
    const selector = this.settings.isCherry || this.settings.isAll ? '.toggle' : '.page-body > ul'
    return dom(selector).toArray()
  }

  removeNestedToggles (input: string) {
    return input
      .replace(/<details(.*?)>(.*?)<\/details>/g, '')
      .replace(/<summary>(.*?)<\/summary>/g, '')
      .replace(/<li><\/li>/g, '')
      .replace(/<ul[^/>][^>]*><\/ul>/g, '')
      .replace(/<\/details><\/li><\/ul><\/details><\/li><\/ul>/g, '')
      .replace(/<\/details><\/li><\/ul>/g, '')
      .replace(/<p[^/>][^>]*><\/p>/g, '')
  }

  setFontSize (style: string) {
    let fontSize = this.settings.fontSize
    if (fontSize && fontSize !== '20px') { // For backwards compatability, don't touch the font-size if it's 20px
    fontSize = fontSize.trim().endsWith('px') ? fontSize : fontSize + 'px'
      style += '\n' + '* { font-size:' + fontSize + '}'
    }
    return style
  }

  handleHTML (fileName: string, contents: string, deckName: string, decks: Deck[]) {
    const dom = cheerio.load(this.settings.noUnderline ? contents.replace(/border-bottom:0.05em solid/g, '') : contents)
    let name = deckName || dom('title').text()
    let style = dom('style').html()
    if (style) {
      style = style.replace(/white-space: pre-wrap;/g, '')
      style = this.setFontSize(style)
    }

    let image: string | undefined = ""
    const pageCoverImage = dom('.page-cover-image')
    if (pageCoverImage) {
      image = pageCoverImage.attr('src')
    }

    const pageIcon = dom('.page-header-icon > .icon')
    const pi = pageIcon.html()
    if (pi) {
      if (!name.includes(pi) && decks.length === 0) {
        if (!name.includes('::') && !name.startsWith(pi)) {
          name = `${pi} ${name}`
        } else {
          const names = name.split(/::/)
          const end = names.length - 1
          const last = names[end]
          names[end] = `${pi} ${last}`
          name = names.join('::')
        }
      }
    }

    this.globalTags = dom('.page-body > p > del')
    const toggleList = this.findToggleLists(dom)
    let cards: Note[] = []

    toggleList.forEach((t) => {
      // We want to perserve the parent's style, so getting the class
      const p = dom(t)
      const parentUL = p
      const parentClass = p.attr('class') || ""

      if (this.settings.toggleMode === 'open_toggle') {
        dom('details').attr('open', '')
      } else if (this.settings.toggleMode === 'close_toggle') {
        dom('details').removeAttr('open')
      }

      if (parentUL) {
        dom('details').addClass(parentClass)
        dom('summary').addClass(parentClass)
        const summary = parentUL.find('summary').first()
        const toggle = parentUL.find('details').first()

        if (summary && summary.text()) {
          const front = parentClass ? `<div class='${parentClass}'>${summary.html()}</div>` : summary.html()
          if ((summary && toggle) || (this.settings.maxOne && toggle.text())) {
            const toggleHTML = toggle.html()
            if (toggleHTML) {
              let b = toggleHTML.replace(summary.html() || '', '')
              if (this.settings.isTextOnlyBack) {
                const paragraphs = dom(toggle).find('> p').toArray()
                b = ''
                for (const paragraph of paragraphs) {
                  if (paragraph) {
                    b += dom(paragraph).html()
                  }
                }                
              }
              const note = new Note(front || "", this.settings.maxOne ? this.removeNestedToggles(b) : b)
                if (this.settings.isCherry && !this.noteHasCherry(note)) {
                  console.log('dropping due to cherry rules')
                }
                cards.push(note)
            }
          }
        }       
      }
    })

    //  Prevent bad cards from leaking out
    cards = cards.filter(Boolean)
    cards = this.sanityCheck(cards)

    decks.push(new Deck(name, cards, image, style, this.generateId()))

    const subpages = dom('.link-to-page').toArray()
    for (const page of subpages) {
      const spDom = dom(page)
      const ref = spDom.find('a').first()
      const href = ref.attr('href')
      const pageContent = this.findNextPage(href, fileName)
      if (pageContent && name) {
        const subDeckName = spDom.find('title').text() || ref.text()
        this.handleHTML(fileName, pageContent, `${name}::${subDeckName}`, decks)
      }
    }
    return decks
  }

  hasClozeDeletions (input: string) {
    if (!input) {
      return false
    }
    return input.includes('code')
  }

  validInputCard (input: Note) {
    if (!this.settings.useInput) {
      return false
    }
    return input.name && input.name.includes('strong')
  }

  sanityCheck (cards: Note[]) {
    return cards.filter(c => c.name && (this.hasClozeDeletions(c.name) || c.back || this.validInputCard(c)))
  }

  // Try to avoid name conflicts && invalid characters by hashing
  newUniqueFileName (input: string) {
    const shasum = crypto.createHash('sha1')
    shasum.update(input)
    return shasum.digest('hex')
  }

  suffix (input: string) {
    if (!input) {
      return null
    }
    const m = input.match(/\.[0-9a-z]+$/i)
    if (!m) {
      return null
    }
    return m[0]
  }

  setupExporter (deck: Deck, workspace: string) {
    const css = deck.cleanStyle()
    fs.mkdirSync(workspace)
    fs.writeFileSync(path.join(workspace, 'deck_style.css'), css)
    return new CustomExporter(this.firstDeckName, workspace)
  }

  embedFile (exporter: CustomExporter, files: any[], filePath: any) {
    const suffix = this.suffix(filePath)
    if (!suffix) {
      return null
    }
    let file = files[filePath]
    if (!file) {
      const lookup: any = `${exporter.firstDeckName}/${filePath}`.replace(/\.\.\//g, '')
      file = files[lookup]
      if (!file) {
        console.warn(`Missing relative path to ${filePath} used ${exporter.firstDeckName}`)
        return null
      }
    }
    const newName = this.newUniqueFileName(filePath) + suffix
    exporter.addMedia(newName, file)
    return newName
  }

  // https://stackoverflow.com/questions/6903823/regex-for-youtube-id
  getYouTubeID (input: string) {
    return this.ensureNotNull(input, () => {
      try {
        const m = input.match(/(?:youtu\.be\/|youtube\.com(?:\/embed\/|\/v\/|\/watch\?v=|\/user\/\S+|\/ytscreeningroom\?v=|\/sandalsResorts#\w\/\w\/.*\/))([^/&]{10,12})/)
        if (!m || m.length === 0) {
          return null
        }
        // prevent swallowing of soundcloud embeds
        if (m[0].match(/https:\/\/soundcloud.com/)) {
          return null
        }
        return m[1]
      } catch (error) {
        console.log('error in getYouTubeID')
        console.error(error)
        return null
      }
    })
  }

  ensureNotNull (input: string, cb: any) {
    if (!input || !input.trim()) {
      return null
    } else {
      return cb()
    }
  }

  getSoundCloudURL (input: string) {
    return this.ensureNotNull(input, () => {
      try {
        const sre = /https?:\/\/soundcloud\.com\/\S*/gi
        const m = input.match(sre)
        if (!m || m.length === 0) {
          return null
        }
        return m[0].split('">')[0]
      } catch (error) {
        console.log('error in getSoundCloudURL')
        console.error(error)
        return null
      }
    })
  }

  getMP3File (input: string) {
    return this.ensureNotNull(input, () => {
      try {
        const m = input.match(/<a\s+(?:[^>]*?\s+)?href=(["'])(.*?)\1/i)
        if (!m || m.length < 3) {
          return null
        }
        const ma = m[2]
        if (!ma.endsWith('.mp3') || ma.startsWith('http')) {
          return null
        }
        return ma
      } catch (error) {
        return null
      }
    })
  }

  handleClozeDeletions (input: string) {
    const dom = cheerio.load(input)
    const clozeDeletions = dom('code')
    let mangle = input
    let num = 1
    clozeDeletions.each((i, elem) => {
      const v = dom(elem).html()
  if (v) {

      // User has set the cloze number
      if (v.includes('{{c') && v.includes('}}') && !v.includes('KaTex')) {
        // make Statement unreachable bc. even clozes can get such a formation
        // eg: \frac{{c}} 1 would give that.
        mangle = replaceAll(mangle, `<code>${v}</code>`, v)
      } else {
        const old = `<code>${v}</code>`
        // prevent "}}" so that anki closes the Cloze at the right }} not this one
        const vReplaced  = replaceAll(v, "}}", "} }")
        const newValue = '{{c' + num + '::' + vReplaced + '}}'
          mangle = replaceAll(mangle, old, newValue)
        num += 1
      }
}
    })
    return mangle
  }

  treatBoldAsInput (input: string, inline: boolean) {
    const dom = cheerio.load(input)
    const underlines = dom('strong')
    let mangle = input
    let answer = ''
    underlines.each((i, elem) => {
      const v = dom(elem).html()
      if (v) {
        const old = `<strong>${v}</strong>`
        mangle = replaceAll(mangle, old, inline ? v : '{{type:Input}}')
        answer = v
      }
    })
    return { mangle, answer }
  }

  generateId () {
    return parseInt(customAlphabet('1234567890', 16)(), 10)
  }

  locateTags (card: Note) {
    const input = [card.name, card.back]

    for (const i of input) {
      if (!i) {
        continue
      }

      const dom = cheerio.load(i)
      const deletionsDOM = dom('del')
      const deletionsArray = [deletionsDOM, this.globalTags]
      if (!card.tags) {
        card.tags = []
      }
      for (const deletions of deletionsArray) {
        deletions.each((elem: any) => {
          const del = dom(elem)
          card.tags.push(...del.text().split(',').map($1 => $1.trim().replace(/\s/g, '-')))
          card.back = replaceAll(card.back, `<del>${del.html()}</del>`, '')
          card.name = replaceAll(card.name, `<del>${del.html()}</del>`, '')
        })
      }
    }
    return card
  }

  async build () {
    const ws = process.env.WORKSPACE_BASE
    if (!ws) {
      throw new Error("Undefined workspace")
    }
    const workspace = path.join(ws, nanoid())
    const exporter = this.setupExporter(this.payload[0], workspace)

    for (const d of this.payload) {
      const deck = d
      deck['empty-deck-desc'] = this.settings.isEmptyDescription
      const cardCount = deck.cards.length
      deck.image_count = 0

      deck.cardCount = cardCount
      deck.id = this.generateId()
      delete deck.style

      // Counter for perserving the order in Anki deck.
      let counter = 0
      const addThese = []
      for (const c of deck.cards) {
        let card = c
        card['enable-input'] = this.settings.useInput
        card.cloze = this.settings.isCloze
        card.number = counter++

        if (card.cloze) {
          card.name = this.handleClozeDeletions(card.name)
        }

        if (this.settings.useInput && card.name.includes('<strong>')) {
          const inputInfo = this.treatBoldAsInput(card.name, false)
          card.name = inputInfo.mangle
          card.answer = inputInfo.answer
        }

        card.media = []
        if (card.back) {
          const dom = cheerio.load(card.back)
          const images = dom('img')      
          if (images.length > 0) {
            images.each((_i, elem) => {
              const originalName = dom(elem).attr('src')
              if (originalName && !originalName.startsWith('http')) {
                const newName = this.embedFile(exporter, this.files, global.decodeURIComponent(originalName))
                if (newName) {
                  dom(elem).attr('src', newName)
                  card.media.push(newName)
                }
              }
            })
            deck.image_count += (card.back.match(/<+\s?img/g) || []).length
            card.back = dom.html()
          }

          const audiofile = this.getMP3File(card.back)
          if (audiofile) {
            const newFileName = this.embedFile(exporter, this.files, global.decodeURIComponent(audiofile))
            if (newFileName) {
              card.back += `[sound:${newFileName}]`
              card.media.push(newFileName)
            }
          }
          // Check YouTube
          const id = this.getYouTubeID(card.back)
          if (id) {
            const ytSrc = `https://www.youtube.com/embed/${id}?`.replace(/"/, '')
            const video = `<iframe width='560' height='315' src='${ytSrc}' frameborder='0' allowfullscreen></iframe>`
            card.back += video
          }

          const soundCloudUrl = this.getSoundCloudURL(card.back)
          if (soundCloudUrl) {
            const audio = `<iframe width='100%' height='166' scrolling='no' frameborder='no' src='https://w.soundcloud.com/player/?url=${soundCloudUrl}'></iframe>`
            card.back += audio
          }

          if (this.settings.useInput && card.back.includes('<strong>')) {
            const inputInfo = this.treatBoldAsInput(card.back, true)
            card.back = inputInfo.mangle
          }
        }

        if (!card.tags) {
          card.tags = []
        }
        if (this.settings.useTags) {
          card = this.locateTags(card)
        }

        if (this.settings.basicReversed) {
          addThese.push({ name: card.back, back: card.name, tags: card.tags, media: card.media, number: counter++ })
        }

        if (this.settings.reversed) {
          const tmp = card.back
          card.back = card.name
          card.name = tmp
        }
      }
      deck.cards = deck.cards.concat(addThese)
    }

    this.payload[0].cloze_model_name = this.settings.clozeModelName
    this.payload[0].basic_model_name = this.settings.basicModelName
    this.payload[0].input_model_name = this.settings.inputModelName
    this.payload[0].cloze_model_id = this.settings.clozeModelId
    this.payload[0].basic_model_id = this.settings.basicModelId
    this.payload[0].input_model_id = this.settings.inputModelId
    this.payload[0].template = this.settings.template

    exporter.configure(this.payload)
    return exporter.save()
  }
}

export async function PrepareDeck (fileName: string, files: any, settings: Settings) {
  const parser = new DeckParser(fileName, settings, files)
  const apkg = await parser.build()
  return { name: `${parser.name}.apkg`, apkg, deck: parser.payload }
}